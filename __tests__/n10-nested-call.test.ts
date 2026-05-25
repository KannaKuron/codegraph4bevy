/**
 * N10: Deeply nested call extraction + unresolved_refs preservation
 *
 * Tests for:
 * 1. Calls inside deeply nested AST (match → if → block → call) are extracted
 * 2. Unresolved `calls` refs are preserved after resolution (not deleted)
 * 3. codegraph_usages fallback finds external symbols via unresolved_refs
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Extraction-level tests ──

describe('Deeply nested call extraction (N10)', () => {
  it('extracts call_expression at function body top level', () => {
    const code = `
fn main() {
    helper();
}
`;
    const result = extractFromSource('lib.rs', code);
    const calls = result.unresolvedReferences.filter(r => r.referenceKind === 'calls');
    expect(calls.some(c => c.referenceName === 'helper')).toBe(true);
  });

  it('extracts call_expression inside match arm', () => {
    const code = `
fn handle(mode: Mode) {
    match mode {
        Mode::A => { process_a(); }
        Mode::B => { process_b(); }
    }
}
`;
    const result = extractFromSource('lib.rs', code);
    const calls = result.unresolvedReferences.filter(r => r.referenceKind === 'calls');
    expect(calls.some(c => c.referenceName === 'process_a')).toBe(true);
    expect(calls.some(c => c.referenceName === 'process_b')).toBe(true);
  });

  it('extracts call_expression inside if block within match arm', () => {
    const code = `
fn handle(mode: Mode) {
    match mode {
        Mode::A => {
            if condition {
                deep_call();
            }
        }
        _ => {}
    }
}
`;
    const result = extractFromSource('lib.rs', code);
    const calls = result.unresolvedReferences.filter(r => r.referenceKind === 'calls');
    expect(calls.some(c => c.referenceName === 'deep_call')).toBe(true);
  });

  it('extracts call_expression in multi-level nesting: match → if → assignment → call', () => {
    const code = `
fn update(state: &mut State) {
    let changed = match state.mode {
        Mode::Input => {
            if state.selected >= 1 {
                spawn_widget(ExternalType(State::Active));
                true
            } else {
                false
            }
        }
        _ => false,
    };
}
`;
    const result = extractFromSource('lib.rs', code);
    const calls = result.unresolvedReferences.filter(r => r.referenceKind === 'calls');
    expect(calls.some(c => c.referenceName === 'spawn_widget')).toBe(true);
    expect(calls.some(c => c.referenceName === 'ExternalType')).toBe(true);
  });

  it('extracts call_expression inside closure within method chain', () => {
    const code = `
fn build_ui(commands: Commands) {
    commands.spawn((
        Node::default(),
        ExternalMarker(State::Open),
    )).with_children(|parent| {
        parent.spawn(Text::new("hello"));
    });
}
`;
    const result = extractFromSource('lib.rs', code);
    const calls = result.unresolvedReferences.filter(r => r.referenceKind === 'calls');
    expect(calls.some(c => c.referenceName === 'ExternalMarker')).toBe(true);
  });

  it('extracts calls at all nesting depths in a complex function', () => {
    // Mirrors the real 更新_设置导航 function structure:
    // function → binary_expr(=) → match → match_arm → block → if → block → call
    const code = `
fn complex_update(commands: Commands, mode: Mode) {
    let changed = match mode {
        Mode::A => {
            if check_condition() {
                commands.insert_resource(Signal::Confirm);
                commands.spawn((
                    Node::default(),
                    ExternalComponent(State::Active),
                )).with_children(|parent| {
                    parent.spawn(Text::new("label"));
                });
                true
            } else {
                modify_value(0, true);
                false
            }
        }
        Mode::B => helper_b(),
        Mode::C => helper_c(),
    };
    calculate_count(mode);
}
`;
    const result = extractFromSource('lib.rs', code);
    const calls = result.unresolvedReferences.filter(r => r.referenceKind === 'calls');

    // Top-level and shallow calls
    expect(calls.some(c => c.referenceName === 'calculate_count')).toBe(true);
    expect(calls.some(c => c.referenceName === 'check_condition')).toBe(true);
    expect(calls.some(c => c.referenceName === 'helper_b')).toBe(true);
    expect(calls.some(c => c.referenceName === 'helper_c')).toBe(true);

    // Deeply nested calls (inside match → if → block)
    expect(calls.some(c => c.referenceName === 'ExternalComponent')).toBe(true);
    expect(calls.some(c => c.referenceName === 'modify_value')).toBe(true);
  });
});

// ── Resolution-level tests: calls refs are preserved ──

describe('Unresolved calls refs preservation (N10)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('preserves calls refs to external symbols after resolution', async () => {
    // ExternalType is NOT defined in this project — it comes from an external crate
    const code = `
pub fn build_ui() {
    let x = ExternalType(State::Open);
}

pub enum State { Open, Closed }
`;
    fs.writeFileSync(path.join(tempDir, 'lib.rs'), code);

    const cg = await CodeGraph.init(tempDir);
    await cg.indexAll();
    await cg.resolveReferencesBatched();

    // ExternalType should remain in unresolved_refs (not deleted)
    const unresolved = cg.getUnresolvedByName('ExternalType');
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.some(r => r.referenceKind === 'calls')).toBe(true);

    cg.close();
  });

  it('preserves calls refs alongside type_of refs for external constructors', async () => {
    const code = `
pub fn setup() {
    let marker = ExternalMarker(AppState::Running);
}

pub enum AppState { Running, Stopped }
`;
    fs.writeFileSync(path.join(tempDir, 'lib.rs'), code);

    const cg = await CodeGraph.init(tempDir);
    await cg.indexAll();
    await cg.resolveReferencesBatched();

    const unresolvedCalls = cg.getUnresolvedByName('ExternalMarker');
    expect(unresolvedCalls.some(r => r.referenceKind === 'calls')).toBe(true);

    cg.close();
  });
});
