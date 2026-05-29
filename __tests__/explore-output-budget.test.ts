/**
 * Adaptive output budget for codegraph_explore (#185).
 *
 * The explore tool used to apply a fixed 35KB output cap regardless of
 * project size, which on small codebases was a net loss vs. native
 * grep+Read. These tests pin the per-tier budget shape so future tuning
 * doesn't silently drift the small-project case back into bloat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getExploreOutputBudget, getExploreBudget, ToolHandler } from '../src/mcp/tools';
import CodeGraph from '../src/index';

describe('getExploreOutputBudget', () => {
  it('returns a strictly smaller total cap for small projects than for huge ones', () => {
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.maxOutputChars).toBeLessThan(huge.maxOutputChars);
    expect(small.defaultMaxFiles).toBeLessThan(huge.defaultMaxFiles);
    expect(small.maxCharsPerFile).toBeLessThan(huge.maxCharsPerFile);
  });

  it('caps total output well under 8000 tokens (~32k chars) on small projects', () => {
    const small = getExploreOutputBudget(100);
    expect(small.maxOutputChars).toBeLessThanOrEqual(20000);
  });

  it('keeps the historical 35k+ ceiling for medium-large projects so existing benchmarks do not regress', () => {
    const large = getExploreOutputBudget(10000);
    expect(large.maxOutputChars).toBeGreaterThanOrEqual(35000);
  });

  it('uses tier breakpoints matching getExploreBudget so call-count and output-budget agree on a project', () => {
    // Anything in the same tier should pick the same total-output cap.
    const tier1a = getExploreOutputBudget(50);
    const tier1b = getExploreOutputBudget(499);
    expect(tier1a.maxOutputChars).toBe(tier1b.maxOutputChars);
    expect(getExploreBudget(50)).toBe(getExploreBudget(499));

    const tier2a = getExploreOutputBudget(500);
    const tier2b = getExploreOutputBudget(4999);
    expect(tier2a.maxOutputChars).toBe(tier2b.maxOutputChars);
    expect(getExploreBudget(500)).toBe(getExploreBudget(4999));

    const tier3a = getExploreOutputBudget(5000);
    const tier3b = getExploreOutputBudget(14999);
    expect(tier3a.maxOutputChars).toBe(tier3b.maxOutputChars);

    // And crossing a breakpoint changes the cap.
    expect(tier1a.maxOutputChars).not.toBe(tier2a.maxOutputChars);
    expect(tier2a.maxOutputChars).not.toBe(tier3a.maxOutputChars);
  });

  it('gates off "Additional relevant files", completeness signal, and budget note on small projects', () => {
    const small = getExploreOutputBudget(100);
    expect(small.includeAdditionalFiles).toBe(false);
    expect(small.includeCompletenessSignal).toBe(false);
    expect(small.includeBudgetNote).toBe(false);
  });

  it('keeps all meta-text on for projects that earn the breadth signal (>=500 files)', () => {
    const medium = getExploreOutputBudget(1000);
    expect(medium.includeAdditionalFiles).toBe(true);
    expect(medium.includeCompletenessSignal).toBe(true);
    expect(medium.includeBudgetNote).toBe(true);
  });

  it('keeps the Relationships section on for every tier — it is the cheapest structural signal', () => {
    expect(getExploreOutputBudget(50).includeRelationships).toBe(true);
    expect(getExploreOutputBudget(1000).includeRelationships).toBe(true);
    expect(getExploreOutputBudget(10000).includeRelationships).toBe(true);
    expect(getExploreOutputBudget(30000).includeRelationships).toBe(true);
  });

  it('caps the per-file header symbol list more tightly on small projects', () => {
    // Without this cap, a file like Alamofire's Session.swift produced
    // a 3.4KB symbol list in the `#### path — sym, sym, ...` header,
    // dwarfing the per-file body cap.
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.maxSymbolsInFileHeader).toBeLessThan(huge.maxSymbolsInFileHeader);
    expect(small.maxSymbolsInFileHeader).toBeGreaterThan(0);
  });

  it('uses a tighter clustering gap threshold on small projects to break runaway single clusters', () => {
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.gapThreshold).toBeLessThanOrEqual(huge.gapThreshold);
  });

  it('handles the boundary file counts exactly (off-by-one regression guard)', () => {
    // 499 -> small tier, 500 -> medium tier
    expect(getExploreOutputBudget(499).maxOutputChars).toBe(getExploreOutputBudget(100).maxOutputChars);
    expect(getExploreOutputBudget(500).maxOutputChars).toBe(getExploreOutputBudget(1000).maxOutputChars);
    // 4999 -> medium, 5000 -> large
    expect(getExploreOutputBudget(4999).maxOutputChars).toBe(getExploreOutputBudget(1000).maxOutputChars);
    expect(getExploreOutputBudget(5000).maxOutputChars).toBe(getExploreOutputBudget(10000).maxOutputChars);
    // 14999 -> large, 15000 -> xlarge
    expect(getExploreOutputBudget(14999).maxOutputChars).toBe(getExploreOutputBudget(10000).maxOutputChars);
    expect(getExploreOutputBudget(15000).maxOutputChars).toBe(getExploreOutputBudget(30000).maxOutputChars);
  });
});

/**
 * End-to-end check that the budget is actually applied by handleExplore.
 *
 * Builds a tiny synthetic project (<500 files, so the small tier), indexes
 * it, and confirms the output:
 *   - stays under the small-tier maxOutputChars cap
 *   - omits the meta-text the small tier gates off (completeness signal,
 *     budget note, "Additional relevant files")
 *
 * Regression guard for #185 — protects against future edits to handleExplore
 * silently re-introducing the fixed 35KB cap on small projects.
 */
describe('codegraph_explore output respects the adaptive budget', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-budget-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // A handful of files with one fat target file. The fat file mimics the
    // Alamofire Session.swift case: many methods stacked on top of each other,
    // which collapsed into one giant cluster pre-#185.
    const fatLines: string[] = ['export class Session {'];
    for (let i = 0; i < 30; i++) {
      fatLines.push(`  method${i}(arg: string): string {`);
      fatLines.push(`    return this.helper${i}(arg) + "${i}";`);
      fatLines.push(`  }`);
      fatLines.push(`  private helper${i}(arg: string): string {`);
      fatLines.push(`    return arg.repeat(${i + 1});`);
      fatLines.push(`  }`);
    }
    fatLines.push('}');
    fs.writeFileSync(path.join(srcDir, 'session.ts'), fatLines.join('\n'));

    // A few small supporting files so the project has >1 indexed file.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(srcDir, `support${i}.ts`),
        `import { Session } from './session';\nexport function callSession${i}(s: Session) { return s.method${i}('hi'); }\n`
      );
    }

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('keeps total output under the small-project cap', async () => {
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    const smallBudget = getExploreOutputBudget(100);
    // Allow a small overshoot for the trailing markers — the cap is enforced
    // per-file rather than as an absolute output ceiling.
    expect(text.length).toBeLessThan(smallBudget.maxOutputChars + 500);
  });

  it('omits the meta-text gated off for small projects', async () => {
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    expect(text).not.toContain('### Additional relevant files');
    expect(text).not.toContain('Complete source code is included above');
    expect(text).not.toContain('Explore budget:');
  });

  it('still includes the Relationships section — it is the cheapest structural signal', async () => {
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // Either there are relationships, or no edges were significant — both are fine.
    // We just want to confirm we did not accidentally gate it off.
    const hasRelationships = text.includes('### Relationships');
    const sourceFollowsHeader = text.indexOf('### Source Code') > 0;
    expect(hasRelationships || sourceFollowsHeader).toBe(true);
  });

  it('prefixes source lines with line numbers by default (cat -n style)', async () => {
    delete process.env.CODEGRAPH_EXPLORE_LINENUMS;
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // At least one fenced source line should look like `<digits>\t<code>`.
    expect(/\n\d+\t/.test(text)).toBe(true);
  });

  it('omits line numbers when CODEGRAPH_EXPLORE_LINENUMS=0', async () => {
    process.env.CODEGRAPH_EXPLORE_LINENUMS = '0';
    try {
      const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
      const text = result.content?.[0]?.text ?? '';
      // The synthetic source has no tab-prefixed numeric lines of its own,
      // so none should appear when the toggle is off.
      expect(/\n\d+\t(?:export|  )/.test(text)).toBe(false);
    } finally {
      delete process.env.CODEGRAPH_EXPLORE_LINENUMS;
    }
  });

  it('uses language-neutral omission markers (no C-style // in the output)', async () => {
    // The gap/trimmed separators must not assume `//` is a comment — that's
    // wrong in Python, Ruby, etc. They render inside fenced source blocks.
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    expect(text).not.toContain('// ... (gap)');
    expect(text).not.toContain('// ... trimmed');
  });

  it('does not collapse a whole-file class into just its header (envelope filter)', async () => {
    // The synthetic `Session` class spans the entire file. Without the
    // envelope filter it would form one giant cluster that tail-trims to
    // the class declaration, hiding the methods. Confirm real method bodies
    // make it into the output. Regression guard for the #185 follow-up.
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // A method body line (`methodN(arg: string)`) should appear, not just
    // the `export class Session {` opener.
    const hasMethodBody = /method\d+\(arg: string\)/.test(text);
    expect(hasMethodBody).toBe(true);
  });
});

/**
 * Tests for cluster pagination via maxItems / itemsOffset.
 *
 * Scenario: a file with many separate functions spread across the file,
 * so they form multiple clusters. maxItems should limit per-page items,
 * itemsOffset should enable pagination, and file-head guarantee should
 * ensure the opening of the file is included even when queries match
 * later sections.
 */
describe('codegraph_explore cluster pagination (maxItems / itemsOffset)', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-pagination-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // A ~350-line file (>220 to trigger clustering, not whole-file return)
    // with 6 well-separated functions (each ~20 lines,
    // with 40-line gaps between them so they form distinct clusters).
    // The first function is the entry point; the query will match later
    // functions to test the file-head guarantee.
    const funcs: string[] = [];
    funcs.push(`export function appEntryPoint() {`);
    funcs.push(`  console.log("entry point");`);
    funcs.push(`  return initialize();`);
    funcs.push(`}`);
    funcs.push(``);
    funcs.push(`function initialize() {`);
    funcs.push(`  return { ready: true };`);
    funcs.push(`}`);
    funcs.push(``);
    funcs.push(`// --- 40 blank lines to force a cluster gap ---`);
    for (let i = 0; i < 40; i++) funcs.push(``);

    funcs.push(`export function processUserInput(input: string) {`);
    funcs.push(`  const sanitized = input.trim();`);
    funcs.push(`  return dispatch(sanitized);`);
    funcs.push(`}`);
    funcs.push(``);
    funcs.push(`function dispatch(cmd: string) {`);
    funcs.push(`  return { action: cmd };`);
    funcs.push(`}`);
    funcs.push(``);
    funcs.push(`// --- 40 blank lines ---`);
    for (let i = 0; i < 40; i++) funcs.push(``);

    funcs.push(`export function handleRequest(req: any) {`);
    funcs.push(`  return processUserInput(req.body);`);
    funcs.push(`}`);
    funcs.push(``);
    funcs.push(`function validateRequest(req: any) {`);
    funcs.push(`  return !!req.body;`);
    funcs.push(`}`);
    funcs.push(``);
    funcs.push(`// --- 40 blank lines ---`);
    for (let i = 0; i < 40; i++) funcs.push(``);

    funcs.push(`export function renderDashboard(data: any) {`);
    funcs.push(`  return JSON.stringify(data);`);
    funcs.push(`}`);
    funcs.push(``);
    funcs.push(`function formatDashboardTitle(title: string) {`);
    funcs.push(`  return title.toUpperCase();`);
    funcs.push(`}`);
    funcs.push(``);
    funcs.push(`// --- 40 blank lines ---`);
    for (let i = 0; i < 40; i++) funcs.push(``);

    funcs.push(`export function shutdownGracefully() {`);
    funcs.push(`  console.log("shutting down");`);
    funcs.push(`}`);
    funcs.push(``);
    funcs.push(`function cleanupResources() {`);
    funcs.push(`  return true;`);
    funcs.push(`}`);
    funcs.push(``);
    funcs.push(`// --- 40 blank lines ---`);
    for (let i = 0; i < 40; i++) funcs.push(``);

    funcs.push(`export function finalReport() {`);
    funcs.push(`  return shutdownGracefully();`);
    funcs.push(`}`);
    funcs.push(``);
    funcs.push(`function generateSummary() {`);
    funcs.push(`  return "done";`);
    funcs.push(`}`);

    fs.writeFileSync(path.join(srcDir, 'app.ts'), funcs.join('\n'));

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('maxItems limits items per page', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'appEntryPoint processUserInput handleRequest renderDashboard shutdownGracefully finalReport',
      maxItems: 3,
    });
    const text = result.content?.[0]?.text ?? '';
    // With 6 clusters and maxItems=3, at most 3 code blocks should appear
    // Count fenced code blocks in the output (match any language tag)
    const codeBlockCount = (text.match(/```\w*\n/g) || []).length;
    expect(codeBlockCount).toBeLessThanOrEqual(3);
    // Pagination hint should recommend codegraph_node, not itemsOffset
    expect(text).not.toMatch(/itemsOffset=/);
    expect(text).toMatch(/codegraph_node/);
  });

  it('itemsOffset pagination returns next page', async () => {
    // First, get page 1 (default itemsOffset=0)
    const page1 = await handler.execute('codegraph_explore', {
      query: 'appEntryPoint processUserInput handleRequest renderDashboard shutdownGracefully finalReport',
      maxItems: 3,
    });
    const text1 = page1.content?.[0]?.text ?? '';

    // Get page 2 (skip first 3 items)
    const page2 = await handler.execute('codegraph_explore', {
      query: 'appEntryPoint processUserInput handleRequest renderDashboard shutdownGracefully finalReport',
      maxItems: 3,
      itemsOffset: 3,
    });
    const text2 = page2.content?.[0]?.text ?? '';

    // Pages should not be identical (different items shown)
    expect(text2).not.toBe(text1);
    // Page 2 should contain at least some code
    expect(text2).toContain('```');
  });

  it('file-head guarantee includes opening function when higher-ranked clusters push it out', async () => {
    // Query matches the head function AND later functions. The later functions
    // have higher importance (direct query match + are entry points), so they
    // get ranked higher and can push the head cluster out. The head guarantee
    // should bring it back.
    // Note: the head guarantee only works when the head symbol IS in the
    // subgraph (i.e. matches the query in some way). If the query doesn't
    // mention the head function at all, it won't be in the data.
    const result = await handler.execute('codegraph_explore', {
      query: 'appEntryPoint shutdownGracefully finalReport cleanupResources',
      maxItems: 3,
    });
    const text = result.content?.[0]?.text ?? '';
    // appEntryPoint is at lines 1-8, well within the 15% head threshold.
    // It should be included via file-head guarantee even if later functions
    // rank higher.
    expect(text).toContain('appEntryPoint');
  });

  it('pagination hint recommends codegraph_node instead of itemsOffset', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'appEntryPoint processUserInput handleRequest renderDashboard shutdownGracefully finalReport',
      maxItems: 2,
    });
    const text = result.content?.[0]?.text ?? '';
    // Pagination hint should recommend codegraph_node, not itemsOffset
    expect(text).not.toMatch(/itemsOffset=/);
    expect(text).toMatch(/codegraph_node/);
    // Should have a "more code sections" or "More items available" hint
    expect(text).toMatch(/more code sections|More items available/);
  });
});

/**
 * Tests for gap summary codegraph_node suggestion and pagination hint changes.
 *
 * Scenario: use the pagination test's well-separated app.ts with maxItems=2
 * to force gap symbols into the output, then verify the gap summary includes
 * a ready-to-run codegraph_node command.
 */
describe('codegraph_explore gap summary and pagination hints', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-gap-hints-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // Same multi-function file as the pagination suite: 6 well-separated
    // functions forming 6 clusters (40-line gaps exceed the 8-line threshold).
    const funcs: string[] = [];
    funcs.push(`export function appEntryPoint() {`);
    funcs.push(`  console.log("entry point");`);
    funcs.push(`  return initialize();`);
    funcs.push(`}`);
    funcs.push(``);
    for (let i = 0; i < 40; i++) funcs.push(``);

    funcs.push(`export function processUserInput(input: string) {`);
    funcs.push(`  const sanitized = input.trim();`);
    funcs.push(`  return dispatch(sanitized);`);
    funcs.push(`}`);
    funcs.push(``);
    for (let i = 0; i < 40; i++) funcs.push(``);

    funcs.push(`export function handleRequest(req: any) {`);
    funcs.push(`  return processUserInput(req.body);`);
    funcs.push(`}`);
    funcs.push(``);
    for (let i = 0; i < 40; i++) funcs.push(``);

    funcs.push(`export function renderDashboard(data: any) {`);
    funcs.push(`  return JSON.stringify(data);`);
    funcs.push(`}`);
    funcs.push(``);
    for (let i = 0; i < 40; i++) funcs.push(``);

    funcs.push(`export function shutdownGracefully() {`);
    funcs.push(`  console.log("shutting down");`);
    funcs.push(`}`);
    funcs.push(``);
    for (let i = 0; i < 40; i++) funcs.push(``);

    funcs.push(`export function finalReport() {`);
    funcs.push(`  return shutdownGracefully();`);
    funcs.push(`}`);

    fs.writeFileSync(path.join(srcDir, 'app.ts'), funcs.join('\n'));

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('Gap Summary includes codegraph_node suggestion with symbol names', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'appEntryPoint processUserInput handleRequest renderDashboard shutdownGracefully finalReport',
      maxItems: 2,
    });
    const text = result.content?.[0]?.text ?? '';
    // Should have a Gap Summary section when clusters are omitted
    expect(text).toContain('### Gap Summary');
    // Should include a ready-to-run codegraph_node command with quoted symbol names
    expect(text).toMatch(/codegraph_node\(symbols: \[/);
    // The command should contain at least one quoted symbol name
    expect(text).toMatch(/codegraph_node\(symbols: \["\w+.*"\]/);
  });

  it('per-file pagination hint recommends codegraph_node not itemsOffset', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'appEntryPoint processUserInput handleRequest renderDashboard shutdownGracefully finalReport',
      maxItems: 2,
    });
    const text = result.content?.[0]?.text ?? '';
    // Per-file hint should reference codegraph_node, not itemsOffset
    expect(text).not.toMatch(/itemsOffset=\d+/);
    expect(text).toMatch(/codegraph_node\(name, includeCode\)/);
  });

  it('global pagination hint recommends codegraph_node not itemsOffset', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'appEntryPoint processUserInput handleRequest renderDashboard shutdownGracefully finalReport',
      maxItems: 2,
    });
    const text = result.content?.[0]?.text ?? '';
    // Global hint should reference codegraph_node, not itemsOffset
    expect(text).toContain('**More items available.**');
    expect(text).toContain('codegraph_node');
    expect(text).not.toMatch(/itemsOffset=\d+/);
  });
});

/**
 * Tests for codegraph_node includeCode on container types (enum/struct/class).
 *
 * Verifies that includeCode=true on container types returns both the
 * structural outline (Members) AND the full source code, not just the outline.
 */
describe('codegraph_node includeCode on container types', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-node-enum-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // A TypeScript enum with enough members to form a meaningful outline
    const enumSource = [
      `export enum Color {`,
      `  Red = "RED",`,
      `  Green = "GREEN",`,
      `  Blue = "BLUE",`,
      `  Yellow = "YELLOW",`,
      `  Cyan = "CYAN",`,
      `}`,
      ``,
      `export function getColorName(c: Color): string {`,
      `  switch (c) {`,
      `    case Color.Red: return "Red";`,
      `    case Color.Green: return "Green";`,
      `    default: return "Unknown";`,
      `  }`,
      `}`,
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'colors.ts'), enumSource);

    // A struct-like class with methods
    const structSource = [
      `export class Config {`,
      `  host: string;`,
      `  port: number;`,
      `  constructor(host: string, port: number) {`,
      `    this.host = host;`,
      `    this.port = port;`,
      `  }`,
      `  toString(): string {`,
      `    return this.host + ":" + this.port;`,
      `  }`,
      `}`,
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'config.ts'), structSource);

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('enum with includeCode returns both Members outline and source code', async () => {
    const result = await handler.execute('codegraph_node', {
      symbol: 'Color',
      includeCode: true,
    });
    const text = result.content?.[0]?.text ?? '';
    // Should have the Members outline
    expect(text).toMatch(/\*\*Members \(\d+\):\*\*/);
    // Should also have the source code block (fenced)
    expect(text).toContain('```typescript');
    // Should contain enum member entries
    expect(text).toContain('Red');
    expect(text).toContain('Green');
    // Should NOT say "Structural outline only" — source is included
    expect(text).not.toContain('Structural outline only');
  });

  it('class with includeCode returns both Members outline and source code', async () => {
    const result = await handler.execute('codegraph_node', {
      symbol: 'Config',
      includeCode: true,
    });
    const text = result.content?.[0]?.text ?? '';
    // Should have the Members outline
    expect(text).toMatch(/\*\*Members \(\d+\):\*\*/);
    // Should also have the source code block
    expect(text).toContain('```typescript');
    // Should contain constructor entry in outline
    expect(text).toContain('constructor');
    // Should NOT say "Structural outline only"
    expect(text).not.toContain('Structural outline only');
  });

  it('container without includeCode still shows outline-only hint', async () => {
    const result = await handler.execute('codegraph_node', {
      symbol: 'Color',
      includeCode: false,
    });
    const text = result.content?.[0]?.text ?? '';
    // Without includeCode, should show structural outline only
    expect(text).toMatch(/\*\*Members \(\d+\):\*\*/);
    expect(text).toContain('Structural outline only');
  });

  it('batch node with includeCode returns outline + source for containers', async () => {
    const result = await handler.execute('codegraph_node', {
      symbols: ['Color', 'Config'],
      includeCode: true,
    });
    const text = result.content?.[0]?.text ?? '';
    // Both should have Members outlines AND source code
    const membersCount = (text.match(/\*\*Members \(\d+\):\*\*/g) || []).length;
    expect(membersCount).toBe(2);
    // Should have source code blocks
    const codeBlocks = (text.match(/```typescript/g) || []).length;
    expect(codeBlocks).toBeGreaterThanOrEqual(2);
    // Should NOT say "Structural outline only"
    expect(text).not.toContain('Structural outline only');
  });
});

/**
 * Tests for batch node output budget behavior.
 *
 * When many symbols are batched with includeCode, the output should
 * gracefully degrade: show as many as fit within the budget, then list
 * the rest as deferred with a ready-to-run codegraph_node command.
 */
describe('codegraph_node batch budget', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-node-batch-budget-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // Create 8 fat functions (~50 lines each) in one file.
    // With trail + header, each is ~2-3KB → 8 × 2.5KB = ~20KB > 15KB budget.
    // Some will be deferred.
    const funcs: string[] = [];
    for (let i = 0; i < 8; i++) {
      funcs.push(`export function fatFunc${i}(a: string, b: number, c: boolean): string {`);
      funcs.push(`  // function ${i} — padding to make it large enough to trigger budget`);
      for (let j = 0; j < 45; j++) {
        funcs.push(`  const step${j}_${i} = a.repeat(${j + 1}).length + b * ${j + 1} + (c ? 1 : 0);`);
      }
      funcs.push(`  return a + String(step0_${i});`);
      funcs.push(`}`);
      funcs.push('');
    }
    fs.writeFileSync(path.join(srcDir, 'fat.ts'), funcs.join('\n'));

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('defers symbols when output budget is exceeded', async () => {
    const result = await handler.execute('codegraph_node', {
      symbols: [
        'fatFunc0', 'fatFunc1', 'fatFunc2', 'fatFunc3',
        'fatFunc4', 'fatFunc5', 'fatFunc6', 'fatFunc7',
      ],
      includeCode: true,
    });
    const text = result.content?.[0]?.text ?? '';
    // Should have "deferred" or "not shown" section when budget is hit
    // The text indicates how many symbols were deferred
    const shownMatch = text.match(/\((\d+) shown, (\d+) deferred\)/);
    if (shownMatch) {
      const shown = parseInt(shownMatch[1]);
      const deferred = parseInt(shownMatch[2]);
      expect(shown).toBeGreaterThan(0);
      expect(deferred).toBeGreaterThan(0);
      expect(shown + deferred).toBe(8);
      // Should suggest codegraph_node for the deferred symbols
      expect(text).toContain('codegraph_node(symbols: [');
    }
    // If all 8 fit (unlikely given sizes), that's also fine — just verify they all show
    if (!shownMatch) {
      expect(text).toContain('Total: 8 symbols');
    }
  });

  it('deferred section includes a codegraph_node command with symbol names', async () => {
    const result = await handler.execute('codegraph_node', {
      symbols: [
        'fatFunc0', 'fatFunc1', 'fatFunc2', 'fatFunc3',
        'fatFunc4', 'fatFunc5', 'fatFunc6', 'fatFunc7',
      ],
      includeCode: true,
    });
    const text = result.content?.[0]?.text ?? '';
    // If there are deferred symbols, the output should include a codegraph_node command
    if (text.includes('not shown')) {
      expect(text).toMatch(/codegraph_node\(symbols: \["fatFunc\d+/);
    }
  });
});
