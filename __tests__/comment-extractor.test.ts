import { describe, it, expect } from 'vitest';
import { extractComments } from '../src/extraction/comment-extractor';

describe('comment extractor', () => {
  it('extracts Python docstrings', () => {
    const src = 'def foo():\n    """This is a docstring."""\n    pass\n';
    const comments = extractComments(src, 'test.py', 'python');
    const doc = comments.find((c) => c.kind === 'doc' && c.text.includes('docstring'));
    expect(doc).toBeDefined();
  });

  it('does not extract block comments inside string literals', () => {
    const src = 'const s = "/* not a comment */";\n// real comment\n';
    const comments = extractComments(src, 'test.js', 'javascript');
    const inString = comments.find((c) => c.text.includes('not a comment'));
    expect(inString).toBeUndefined();
    const real = comments.find((c) => c.text === 'real comment');
    expect(real).toBeDefined();
  });

  it('handles escaped quotes when detecting string context', () => {
    // Test extractBlockComments doesn't treat /* */ inside strings as comments.
    // The string mask uses a regex that handles escaped quotes, so:
    //   "he said \"hello\"" → the entire string is masked, not split at the \"
    const src = 'const s = "he said \\"hello\\""; /* real block comment */\n';
    const comments = extractComments(src, 'test.ts', 'typescript');
    const inString = comments.find((c) => c.text.includes('hello'));
    expect(inString).toBeUndefined();
    const real = comments.find((c) => c.text === 'real block comment');
    expect(real).toBeDefined();
  });

  it('extracts Python hash comments alongside docstrings', () => {
    const src = '# hash comment\ndef foo():\n    """docstring"""\n    pass\n';
    const comments = extractComments(src, 'test.py', 'python');
    const hash = comments.find((c) => c.kind === 'line' && c.text === 'hash comment');
    expect(hash).toBeDefined();
    const doc = comments.find((c) => c.kind === 'doc');
    expect(doc).toBeDefined();
  });
});
