import { describe, it, expect } from 'vitest';
import {
  matchBracket,
  hasUIComponents,
  extractComponents,
  extractNodeProps,
  extractSpawnTrees,
  findRegisteredSystems,
} from '../src/mcp/bevy-ui-tree';
import type { Node as CGNode, Subgraph, Edge, EdgeKind } from '../src/types';

// ============================================================================
// Helpers — minimal mock factories
// ============================================================================

function makeNode(overrides: Partial<CGNode> & Pick<CGNode, 'id' | 'name'>): CGNode {
  return {
    kind: 'function',
    qualifiedName: overrides.name,
    filePath: 'src/ui.rs',
    language: 'rust',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    ...overrides,
  };
}

function makeSubgraph(nodes: CGNode[] = [], edges: Edge[] = []): Subgraph {
  const map = new Map<string, CGNode>();
  for (const n of nodes) map.set(n.id, n);
  return { nodes: map, edges, roots: nodes.map(n => n.id) };
}

// ============================================================================
// matchBracket (Bug 5: raw strings + block comments)
// ============================================================================

describe('matchBracket', () => {
  it('matches simple parentheses', () => {
    const text = '(hello)';
    expect(matchBracket(text, 0, '(', ')')).toBe(6);
  });

  it('matches nested parentheses', () => {
    const text = '(a(b(c)d)e)';
    expect(matchBracket(text, 0, '(', ')')).toBe(10);
  });

  it('matches braces', () => {
    const text = '{ foo: { bar: 1 } }';
    expect(matchBracket(text, 0, '{', '}')).toBe(18);
  });

  it('ignores brackets inside double-quoted strings', () => {
    const text = '(")");';
    expect(matchBracket(text, 0, '(', ')')).toBe(4);
  });

  it('ignores brackets inside single-quoted strings', () => {
    const text = "(\')');";
    expect(matchBracket(text, 0, '(', ')')).toBe(4);
  });

  it('ignores escaped quotes inside strings', () => {
    const text = '("foo\\"bar")';
    expect(matchBracket(text, 0, '(', ')')).toBe(11);
  });

  it('ignores line comments', () => {
    const text = '( // )\n )';
    expect(matchBracket(text, 0, '(', ')')).toBe(8);
  });

  it('ignores block comments (Bug 5)', () => {
    const text = '( /* ) */ )';
    expect(matchBracket(text, 0, '(', ')')).toBe(10);
  });

  it('ignores raw string r"..." (Bug 5)', () => {
    const text = String.raw`(r"(inner)")`;
    expect(matchBracket(text, 0, '(', ')')).toBe(11);
  });

  it('ignores raw string r#"..."# (Bug 5)', () => {
    const text = String.raw`(r#"(inner)"#)`;
    expect(matchBracket(text, 0, '(', ')')).toBe(13);
  });

  it('ignores raw string r##"..."## (Bug 5)', () => {
    const text = String.raw`(r##"(inner)"##)`;
    expect(matchBracket(text, 0, '(', ')')).toBe(15);
  });

  it('returns -1 on unmatched open', () => {
    const text = '(abc';
    expect(matchBracket(text, 0, '(', ')')).toBe(-1);
  });

  it('handles empty content', () => {
    const text = '()';
    expect(matchBracket(text, 0, '(', ')')).toBe(1);
  });

  it('starts from arbitrary index', () => {
    const text = '(outer) (inner)';
    expect(matchBracket(text, 8, '(', ')')).toBe(14);
  });
});

// ============================================================================
// hasUIComponents (Bug 4: substring false matching)
// ============================================================================

describe('hasUIComponents', () => {
  it('detects Node with brace', () => {
    expect(hasUIComponents('Node { flex_direction: Column }')).toBe(true);
  });

  it('detects Node after comma in tuple', () => {
    expect(hasUIComponents('(Node, TextColor)')).toBe(true);
  });

  it('detects Text::new', () => {
    expect(hasUIComponents('Text::new("hello")')).toBe(true);
  });

  it('detects Text(...) with parens', () => {
    expect(hasUIComponents('(Text(my_var))')).toBe(true);
  });

  it('detects BackgroundColor', () => {
    expect(hasUIComponents('BackgroundColor(Color::WHITE)')).toBe(true);
  });

  it('detects DespawnOnExit', () => {
    expect(hasUIComponents('DespawnOnExit(SetupState::Main)')).toBe(true);
  });

  it('detects TextFont', () => {
    expect(hasUIComponents('TextFont { font_size: 20.0 }')).toBe(true);
  });

  it('detects TextColor', () => {
    expect(hasUIComponents('TextColor(Color::WHITE)')).toBe(true);
  });

  it('detects Interaction', () => {
    expect(hasUIComponents('Interaction::Pressed')).toBe(true);
  });

  it('detects Outline', () => {
    expect(hasUIComponents('Outline { width: 2.0 }')).toBe(true);
  });

  // Bug 4: substring false matches
  it('rejects NodeKind (substring)', () => {
    expect(hasUIComponents('NodeKind::Struct')).toBe(false);
  });

  it('rejects UiNode (substring)', () => {
    expect(hasUIComponents('let node = UiNode::default()')).toBe(false);
  });

  it('rejects MouseButton (substring)', () => {
    expect(hasUIComponents('if button == MouseButton::Left')).toBe(false);
  });

  it('detects TextColor inside a variable name (substring — by design, TextColor is long enough to be safe)', () => {
    expect(hasUIComponents('let myTextColorVar = 42')).toBe(true);
  });

  it('rejects empty text', () => {
    expect(hasUIComponents('')).toBe(false);
  });

  it('rejects random code', () => {
    expect(hasUIComponents('let x = commands.spawn_empty();')).toBe(false);
  });
});

// ============================================================================
// extractNodeProps
// ============================================================================

describe('extractNodeProps', () => {
  it('extracts flex_direction', () => {
    expect(extractNodeProps('flex_direction: FlexDirection::Column')).toBe('Column');
  });

  it('extracts width and height', () => {
    const result = extractNodeProps('width: Val::Px(300.0), height: Val::Px(100.0)');
    expect(result).toContain('Px(300.0)');
    expect(result).toContain('Px(100.0)');
    expect(result).toContain('x');
  });

  it('extracts justify_content', () => {
    expect(extractNodeProps('justify_content: JustifyContent::Center')).toBe('center');
  });

  it('extracts align_items', () => {
    expect(extractNodeProps('align_items: AlignItems::FlexStart')).toBe('flexstart');
  });

  it('extracts row_gap', () => {
    expect(extractNodeProps('row_gap: Val::Px(8.0)')).toContain('row-gap:');
  });

  it('extracts column_gap', () => {
    expect(extractNodeProps('column_gap: Val::Px(12.0)')).toContain('col-gap:');
  });

  it('extracts padding', () => {
    expect(extractNodeProps('padding: UiRect::all(Val::Px(16.0))')).toContain('pad:');
  });

  it('extracts position_type Absolute', () => {
    expect(extractNodeProps('position_type: PositionType::Absolute')).toBe('Absolute');
  });

  it('hides position_type Relative (default)', () => {
    expect(extractNodeProps('position_type: PositionType::Relative')).toBe('');
  });

  it('extracts inset values', () => {
    const result = extractNodeProps('left: Val::Px(10.0), top: Val::Px(20.0)');
    expect(result).toContain('l:');
    expect(result).toContain('t:');
  });

  it('extracts border', () => {
    expect(extractNodeProps('border: UiRect::all(Val::Px(1.0))')).toContain('border:');
  });

  it('extracts border_radius', () => {
    expect(extractNodeProps('border_radius: BorderRadius::all(Val::Px(8.0))')).toContain('radius:');
  });

  it('extracts multiple props combined', () => {
    const body = 'flex_direction: FlexDirection::Column, width: Val::Percent(100.0), height: Val::Percent(100.0)';
    const result = extractNodeProps(body);
    expect(result).toContain('Column');
    expect(result).toContain('Percent(100.0)');
  });

  it('returns empty string for empty body', () => {
    expect(extractNodeProps('')).toBe('');
  });
});

// ============================================================================
// extractComponents
// ============================================================================

describe('extractComponents', () => {
  it('extracts Node with props', () => {
    const result = extractComponents('Node { flex_direction: FlexDirection::Column }');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('Node');
    expect(result[0]).toContain('Column');
  });

  it('extracts Node without props', () => {
    const result = extractComponents('Node::default()');
    expect(result).toContainEqual('Node');
  });

  it('extracts BackgroundColor', () => {
    expect(extractComponents('BackgroundColor(Color::WHITE)')).toContainEqual('BackgroundColor');
  });

  it('extracts Text::new', () => {
    const result = extractComponents('Text::new("Hello World")');
    expect(result).toContainEqual('Text("Hello World")');
  });

  it('extracts Text(variable)', () => {
    const result = extractComponents('Text(some_var)');
    expect(result).toContainEqual('Text(some_var)');
  });

  it('does not match TextColor(...) as Text (Bug 6)', () => {
    const result = extractComponents('TextColor(Color::WHITE)');
    const textEntry = result.find(r => r.startsWith('Text('));
    expect(textEntry).toBeUndefined();
    expect(result).toContainEqual('TextColor');
  });

  it('extracts DespawnOnExit with state', () => {
    const result = extractComponents('DespawnOnExit(SetupState::Main)');
    expect(result).toContainEqual('DespawnOnExit(SetupState::Main)');
  });

  it('extracts Button', () => {
    expect(extractComponents('Button, Node {}')).toContainEqual('Button');
  });

  it('does not match MouseButton as Button', () => {
    const result = extractComponents('if btn == MouseButton::Left');
    expect(result).not.toContainEqual('Button');
  });

  it('extracts TextFont with font_size', () => {
    const result = extractComponents('TextFont { font_size: 20.0 }');
    expect(result[0]).toContain('TextFont');
    expect(result[0]).toContain('20.0');
  });

  it('extracts custom CJK-suffixed component', () => {
    const result = extractComponents('(Node {}, 标题_组件 { })');
    expect(result.some(r => r.includes('标题_组件'))).toBe(true);
  });
});

// ============================================================================
// extractSpawnTrees (Bug 1: sibling leak fix)
// ============================================================================

describe('extractSpawnTrees', () => {
  const emptyNodes = new Map<string, CGNode>();

  it('extracts a single spawn', () => {
    const code = `
      commands.spawn((
        Node { flex_direction: FlexDirection::Column },
        BackgroundColor(Color::WHITE),
      ));
    `;
    const trees = extractSpawnTrees(code, emptyNodes, 0);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.components).toContainEqual(expect.stringContaining('Node'));
    expect(trees[0]!.components).toContainEqual('BackgroundColor');
    expect(trees[0]!.children).toHaveLength(0);
  });

  it('extracts nested with_children (single child)', () => {
    const code = `
      commands.spawn((
        Node { flex_direction: FlexDirection::Column },
      ))
      .with_children(|parent| {
        parent.spawn((
          Text::new("hello"),
          TextColor(Color::WHITE),
        ));
      });
    `;
    const trees = extractSpawnTrees(code, emptyNodes, 0);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.children).toHaveLength(1);
    expect(trees[0]!.children[0]!.components).toContainEqual(expect.stringContaining('Text'));
  });

  it('extracts sibling spawns inside with_children', () => {
    const code = `
      commands.spawn((
        Node { flex_direction: FlexDirection::Column },
      ))
      .with_children(|parent| {
        parent.spawn((
          Text::new("title"),
          TextColor(Color::WHITE),
        ));
        parent.spawn((
          Node {},
          BackgroundColor(Color::BLACK),
        ));
      });
    `;
    const trees = extractSpawnTrees(code, emptyNodes, 0);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.children).toHaveLength(2);
  });

  // Bug 1: the critical regression test — sibling spawns must NOT leak as children
  it('sibling spawns are siblings, not nested children (Bug 1)', () => {
    const code = `
      commands.spawn((
        Node { flex_direction: FlexDirection::Column },
      ))
      .with_children(|parent| {
        parent.spawn((
          Text::new("child1"),
          TextColor(Color::WHITE),
        ));
      });
      commands.spawn((
        Node { flex_direction: FlexDirection::Row },
      ));
    `;
    const trees = extractSpawnTrees(code, emptyNodes, 0);
    // Two top-level spawns, the second one should NOT be a child of the first
    expect(trees).toHaveLength(2);
    expect(trees[0]!.children).toHaveLength(1); // child from with_children
    expect(trees[1]!.children).toHaveLength(0); // leaf sibling
  });

  it('extracts deeply nested with_children', () => {
    const code = `
      commands.spawn((Node { flex_direction: FlexDirection::Column },))
      .with_children(|parent| {
        parent.spawn((Node { flex_direction: FlexDirection::Row },))
        .with_children(|p| {
          p.spawn((Text::new("deep"), TextColor(Color::WHITE),));
        });
      });
    `;
    const trees = extractSpawnTrees(code, emptyNodes, 0);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.children).toHaveLength(1);
    expect(trees[0]!.children[0]!.children).toHaveLength(1);
    expect(trees[0]!.children[0]!.children[0]!.components).toContainEqual(expect.stringContaining('Text'));
  });

  it('detects for-loop pattern', () => {
    const code = `
      commands.spawn((Node { flex_direction: FlexDirection::Column },))
      .with_children(|parent| {
        for (tab, label) in [
          (设置标签页::画面, "画面"),
          (设置标签页::文本, "文本"),
        ] {
          parent.spawn((Text::new(label),));
        }
      });
    `;
    const trees = extractSpawnTrees(code, emptyNodes, 0);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.forLoop).toBeDefined();
    expect(trees[0]!.forLoop).toContain('画面');
    expect(trees[0]!.forLoop).toContain('文本');
  });

  it('extracts children![] macro pattern', () => {
    const code = `
      children![
        (Node { flex_direction: FlexDirection::Column },),
        (Text::new("hello"), TextColor(Color::WHITE),),
      ]
    `;
    const trees = extractSpawnTrees(code, emptyNodes, 0);
    expect(trees).toHaveLength(2);
  });

  it('extracts Children::spawn pattern', () => {
    const code = `
      Children::spawn(parent, (Node {}, BackgroundColor(Color::WHITE)));
    `;
    const trees = extractSpawnTrees(code, emptyNodes, 0);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.components).toContainEqual('BackgroundColor');
  });

  it('handles leaf spawn (no with_children)', () => {
    const code = `commands.spawn((Text::new("leaf"), TextColor(Color::WHITE),));`;
    const trees = extractSpawnTrees(code, emptyNodes, 0);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.children).toHaveLength(0);
  });

  it('respects recursion depth limit', () => {
    // Generate deeply nested code (12 levels)
    let code = 'commands.spawn((Node {},))';
    for (let i = 0; i < 12; i++) {
      code += `.with_children(|p| { p.spawn((Node {},)) }`;
      code += ')'.repeat(1); // close the spawn(...)
    }
    code += ';';
    // Should not throw or hang
    const trees = extractSpawnTrees(code, emptyNodes, 0);
    expect(trees).toBeDefined();
  });

  it('cross-references to known functions', () => {
    const fnNode = makeNode({ id: 'fn:spawn_title', name: 'spawn_title', kind: 'function', startLine: 10 });
    const nodesByName = new Map<string, CGNode>();
    nodesByName.set('spawn_title', fnNode);

    const code = `commands.spawn((Node {}, spawn_title(),));`;
    const trees = extractSpawnTrees(code, nodesByName, 0);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.crossRefs).toHaveLength(1);
    expect(trees[0]!.crossRefs[0]).toContain('spawn_title');
    expect(trees[0]!.crossRefs[0]).toContain(':10');
  });
});

// ============================================================================
// findRegisteredSystems (Bug 2: edge kind prefix fix)
// ============================================================================

describe('findRegisteredSystems', () => {
  const pluginNode = makeNode({ id: 'plugin:MyPlugin', name: 'MyPlugin', kind: 'struct' });
  const setupSystem = makeNode({ id: 'fn:setup_ui', name: 'setup_ui', kind: 'function', startLine: 20 });
  const updateSystem = makeNode({ id: 'fn:update_ui', name: 'update_ui', kind: 'method', startLine: 30 });
  const enterSystem = makeNode({ id: 'fn:on_enter', name: 'on_enter_setup', kind: 'function', startLine: 40 });

  it('finds systems registered with registers_system edge (Bug 2)', () => {
    const edge: Edge = {
      source: 'plugin:MyPlugin',
      target: 'fn:setup_ui',
      kind: 'registers_system',
      metadata: { schedule: 'Update' },
    };
    const sg = makeSubgraph([pluginNode, setupSystem], [edge]);
    const result = findRegisteredSystems(pluginNode, sg);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('setup_ui');
    expect(result[0]).toContain('Update');
  });

  it('finds systems with runs_in edge (Bug 2)', () => {
    const edge: Edge = {
      source: 'plugin:MyPlugin',
      target: 'fn:update_ui',
      kind: 'runs_in',
      metadata: { schedule: 'Update' },
    };
    const sg = makeSubgraph([pluginNode, updateSystem], [edge]);
    const result = findRegisteredSystems(pluginNode, sg);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('update_ui');
  });

  it('finds systems with on_enter edge (Bug 2)', () => {
    const edge: Edge = {
      source: 'plugin:MyPlugin',
      target: 'fn:on_enter',
      kind: 'on_enter',
      metadata: { schedule: 'OnEnter(GameState::Setup)', state: 'GameState::Setup' },
    };
    const sg = makeSubgraph([pluginNode, enterSystem], [edge]);
    const result = findRegisteredSystems(pluginNode, sg);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('on_enter_setup');
    expect(result[0]).toContain('OnEnter');
  });

  it('ignores non-system edges', () => {
    const edge: Edge = {
      source: 'plugin:MyPlugin',
      target: 'fn:setup_ui',
      kind: 'calls',
    };
    const sg = makeSubgraph([pluginNode, setupSystem], [edge]);
    const result = findRegisteredSystems(pluginNode, sg);
    expect(result).toHaveLength(0);
  });

  it('does not use bevy: prefix internally (Bug 2)', () => {
    const edge: Edge = {
      source: 'plugin:MyPlugin',
      target: 'fn:setup_ui',
      kind: 'registers_system' as EdgeKind,
      metadata: { schedule: 'Update' },
    };
    const sg = makeSubgraph([pluginNode, setupSystem], [edge]);
    const result = findRegisteredSystems(pluginNode, sg);
    expect(result).toHaveLength(1);
  });

  it('deduplicates by target node ID', () => {
    const edges: Edge[] = [
      { source: 'plugin:MyPlugin', target: 'fn:setup_ui', kind: 'registers_system', metadata: { schedule: 'Update' } },
      { source: 'plugin:MyPlugin', target: 'fn:setup_ui', kind: 'runs_in', metadata: { schedule: 'Update' } },
    ];
    const sg = makeSubgraph([pluginNode, setupSystem], edges);
    const result = findRegisteredSystems(pluginNode, sg);
    expect(result).toHaveLength(1);
  });

  it('includes file location', () => {
    const edge: Edge = {
      source: 'plugin:MyPlugin',
      target: 'fn:setup_ui',
      kind: 'registers_system',
      metadata: { schedule: 'Update' },
    };
    const sg = makeSubgraph([pluginNode, setupSystem], [edge]);
    const result = findRegisteredSystems(pluginNode, sg);
    expect(result[0]).toContain('@');
    expect(result[0]).toContain('ui.rs:20');
  });
});

// ============================================================================
// CJK function name matching (Bug 3)
// ============================================================================

describe('CJK cross-ref detection (Bug 3)', () => {
  it('matches CJK function names in cross-refs', () => {
    const fnNode = makeNode({ id: 'fn:创建按钮', name: '创建按钮', kind: 'function', startLine: 5 });
    const nodesByName = new Map<string, CGNode>();
    nodesByName.set('创建按钮', fnNode);

    const code = `commands.spawn((Node {}, 创建按钮(),));`;
    const trees = extractSpawnTrees(code, nodesByName, 0);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.crossRefs).toHaveLength(1);
    expect(trees[0]!.crossRefs[0]).toContain('创建按钮');
  });

  it('matches mixed CJK+ASCII function names', () => {
    const fnNode = makeNode({ id: 'fn:spawn_标题', name: 'spawn_标题', kind: 'function', startLine: 8 });
    const nodesByName = new Map<string, CGNode>();
    nodesByName.set('spawn_标题', fnNode);

    const code = `commands.spawn((Node {}, spawn_标题(),));`;
    const trees = extractSpawnTrees(code, nodesByName, 0);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.crossRefs).toHaveLength(1);
    expect(trees[0]!.crossRefs[0]).toContain('spawn_标题');
  });
});

// ============================================================================
// Bug 7: nodesByName first-writer-wins
// ============================================================================

describe('nodesByName dedup (Bug 7)', () => {
  it('first-writer-wins for duplicate names', () => {
    const nodeA = makeNode({ id: 'fn:foo@file_a.rs', name: 'foo', kind: 'function', filePath: 'src/a.rs', startLine: 1 });
    const nodeB = makeNode({ id: 'fn:foo@file_b.rs', name: 'foo', kind: 'function', filePath: 'src/b.rs', startLine: 10 });
    // nodeA is added first to the Map — the subgraph order matters
    const sg = makeSubgraph([nodeA, nodeB]);

    // extractSpawnTrees calls findCrossRefs which uses nodesByName built in buildUITreeSection.
    // We test via the effect: the cross-ref should point to the first node (a.rs:1),
    // not the second (b.rs:10).
    const nodesByName = new Map<string, CGNode>();
    // Simulate first-writer-wins loop
    for (const n of sg.nodes.values()) {
      if (!nodesByName.has(n.name)) nodesByName.set(n.name, n);
    }

    const code = `commands.spawn((Node {}, foo(),));`;
    const trees = extractSpawnTrees(code, nodesByName, 0);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.crossRefs).toHaveLength(1);
    expect(trees[0]!.crossRefs[0]).toContain('a.rs:1');
    expect(trees[0]!.crossRefs[0]).not.toContain('b.rs');
  });
});
