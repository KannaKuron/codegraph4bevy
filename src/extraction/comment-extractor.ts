/**
 * Comment Extractor
 *
 * Regex-based comment extraction from source code. Handles common
 * comment syntaxes across all languages supported by codegraph.
 * Returns structured comment entries for FTS indexing.
 */

export interface CommentEntry {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  kind: 'line' | 'block' | 'doc';
  associatedSymbol?: string;
}

// Languages using # for line comments
const HASH_COMMENT_LANGS = new Set([
  'python', 'ruby', 'shell', 'bash', 'zsh', 'perl', 'yaml', 'toml',
  'r', 'elixir',
]);

// Languages using -- for line comments
const DASH_COMMENT_LANGS = new Set([
  'sql', 'lua', 'haskell', 'ada',
]);

// Languages using // for line comments
const SLASH_COMMENT_LANGS = new Set([
  'rust', 'typescript', 'tsx', 'javascript', 'jsx', 'java', 'kotlin',
  'swift', 'c_sharp', 'go', 'cpp', 'c', 'scala', 'dart', 'php',
  'zig', 'ocaml',
]);

/**
 * Extract comments from source code using language-appropriate regex.
 */
export function extractComments(
  source: string,
  filePath: string,
  language: string,
): CommentEntry[] {
  const comments: CommentEntry[] = [];
  const lines = source.split('\n');

  if (SLASH_COMMENT_LANGS.has(language) || HASH_COMMENT_LANGS.has(language) || DASH_COMMENT_LANGS.has(language)) {
    extractSingleLineComments(source, lines, filePath, language, comments);
    extractBlockComments(source, lines, filePath, language, comments);
  } else if (language === 'python') {
    extractHashComments(source, lines, filePath, 'line', comments);
    extractPythonDocstrings(source, lines, filePath, comments);
  }

  return comments;
}

function extractSingleLineComments(
  _source: string, lines: string[], filePath: string, language: string, comments: CommentEntry[]
): void {
  let prefix: string;
  if (HASH_COMMENT_LANGS.has(language)) {
    prefix = '#';
  } else if (DASH_COMMENT_LANGS.has(language)) {
    prefix = '--';
  } else {
    prefix = '//';
  }

  // Triple-prefix doc comments: /// (Rust), ### (not standard)
  const docPrefix = prefix + prefix[0];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trimStart();
    if (trimmed.startsWith(prefix) && !trimmed.startsWith('/*') && !trimmed.startsWith('*/')) {
      // Skip if inside a string (rough heuristic)
      const beforeComment = lines[i]!.substring(0, lines[i]!.indexOf(prefix));
      if (isInsideString(beforeComment)) continue;

      const text = trimmed.startsWith(docPrefix)
        ? trimmed.substring(3).trim()  // doc comment
        : trimmed.substring(prefix.length).trim();
      if (!text) continue;

      comments.push({
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        text,
        kind: trimmed.startsWith(docPrefix) ? 'doc' : 'line',
      });
    }
  }
}

function extractHashComments(
  _source: string, lines: string[], filePath: string, kind: 'line' | 'doc', comments: CommentEntry[]
): void {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trimStart();
    if (trimmed.startsWith('#')) {
      const text = trimmed.substring(1).trim();
      if (text) {
        comments.push({ filePath, startLine: i + 1, endLine: i + 1, text, kind });
      }
    }
  }
}

function extractBlockComments(
  source: string, lines: string[], filePath: string, _language: string, comments: CommentEntry[]
): void {
  // Match /* ... */ block comments
  const blockRegex = /\/\*([\s\S]*?)\*\//g;
  let match;
  while ((match = blockRegex.exec(source)) !== null) {
    const body = match[1]!;
    const startLine = getLineNumber(lines, match.index);
    const endLine = getLineNumber(lines, match.index + match[0].length - 1);

    // Clean up: remove leading * on each line (JSDoc style)
    const cleanBody = body.replace(/^\s*\*\s?/gm, '').trim();
    if (!cleanBody) continue;

    const isDoc = match[0].startsWith('/**') && !match[0].startsWith('/*!');
    comments.push({
      filePath,
      startLine,
      endLine,
      text: cleanBody,
      kind: isDoc ? 'doc' : 'block',
    });
  }
}

function extractPythonDocstrings(
  source: string, lines: string[], filePath: string, comments: CommentEntry[]
): void {
  // Match """...""" docstrings
  const docRegex = /"""([\s\S]*?)"""/g;
  let match;
  while ((match = docRegex.exec(source)) !== null) {
    const body = match[1]!.trim();
    if (!body) continue;
    const startLine = getLineNumber(lines, match.index);
    const endLine = getLineNumber(lines, match.index + match[0].length - 1);
    comments.push({
      filePath,
      startLine,
      endLine,
      text: body,
      kind: 'doc',
    });
  }
}

function getLineNumber(lines: string[], charIndex: number): number {
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    total += lines[i]!.length + 1; // +1 for newline
    if (total > charIndex) return i + 1;
  }
  return lines.length;
}

function isInsideString(before: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < before.length; i++) {
    const ch = before[i]!;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
  }
  return inSingle || inDouble;
}
