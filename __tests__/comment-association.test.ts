import { describe, it, expect } from 'vitest';
import { associateCommentWithSymbol } from '../src/extraction';

// Helper: build a candidate symbol
function sym(name: string, startLine: number, endLine: number) {
  return { name, startLine, endLine, qualifiedName: name };
}

describe('associateCommentWithSymbol', () => {
  it('associates /// doc comment with following fn (forward-lookup)', () => {
    // /// doc comment on line 3, fn starts line 4 — gap = 1
    const comment = { startLine: 3, endLine: 3, kind: 'doc' };
    const candidates = [sym('util', 1, 2), sym('conflict_check', 4, 6)];
    expect(associateCommentWithSymbol(comment, candidates)).toBe('conflict_check');
  });

  it('associates multi-line /// last line with the fn after', () => {
    // Two doc comment lines (3, 4), fn on line 5
    // The comment entry for line 4 has endLine=4, gap to fn startLine=5 is 1
    const comment = { startLine: 4, endLine: 4, kind: 'doc' };
    const candidates = [sym('multi_doc', 5, 8)];
    expect(associateCommentWithSymbol(comment, candidates)).toBe('multi_doc');
  });

  it('associates /** */ block doc comment with following struct', () => {
    // Block comment spans lines 1-3, struct starts line 4 — gap = 1
    const comment = { startLine: 1, endLine: 3, kind: 'doc' };
    const candidates = [sym('MyStruct', 4, 7)];
    expect(associateCommentWithSymbol(comment, candidates)).toBe('MyStruct');
  });

  it('does NOT forward-associate regular line comments (kind=line)', () => {
    // Regular // comment on line 1, fn on line 2 — but kind !== 'doc'
    const comment = { startLine: 1, endLine: 1, kind: 'line' };
    const candidates = [sym('unrelated', 2, 4)];
    expect(associateCommentWithSymbol(comment, candidates)).toBeUndefined();
  });

  it('does NOT associate doc comment when gap > 3', () => {
    // Doc comment line 1, fn on line 5 — gap = 4 > 3
    const comment = { startLine: 1, endLine: 1, kind: 'doc' };
    const candidates = [sym('too_far', 5, 8)];
    expect(associateCommentWithSymbol(comment, candidates)).toBeUndefined();
  });

  it('associates doc comment before enum and trait', () => {
    const enumComment = { startLine: 1, endLine: 1, kind: 'doc' };
    const enumCandidates = [sym('Color', 2, 5)];
    expect(associateCommentWithSymbol(enumComment, enumCandidates)).toBe('Color');

    const traitComment = { startLine: 7, endLine: 7, kind: 'doc' };
    const traitCandidates = [sym('Color', 2, 5), sym('Printable', 8, 10)];
    expect(associateCommentWithSymbol(traitComment, traitCandidates)).toBe('Printable');
  });

  it('picks the closest doc comment target when multiple candidates are within gap', () => {
    // Doc comment on line 1, two candidates at gap 1 and gap 2
    const comment = { startLine: 1, endLine: 1, kind: 'doc' };
    const candidates = [sym('far_fn', 3, 5), sym('near_fn', 2, 4)];
    expect(associateCommentWithSymbol(comment, candidates)).toBe('near_fn');
  });

  it('prefers enclosing symbol over forward-lookup', () => {
    // Comment inside a function body — should use enclosing, not forward
    const comment = { startLine: 3, endLine: 3, kind: 'doc' };
    const candidates = [sym('outer_fn', 1, 10), sym('inner_fn', 5, 8)];
    expect(associateCommentWithSymbol(comment, candidates)).toBe('outer_fn');
  });

  it('handles gap of exactly 3 (attribute tolerance)', () => {
    // Doc comment line 1, fn line 4 — gap = 3 (e.g., #[derive(...)])
    const comment = { startLine: 1, endLine: 1, kind: 'doc' };
    const candidates = [sym('derived_fn', 4, 6)];
    expect(associateCommentWithSymbol(comment, candidates)).toBe('derived_fn');
  });
});
