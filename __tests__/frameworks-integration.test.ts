import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Django end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('creates a route->view edge from urls.py to view class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-django-'));
    fs.writeFileSync(path.join(tmpDir, 'manage.py'), '# marker\n');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\n');
    fs.mkdirSync(path.join(tmpDir, 'users'));
    fs.writeFileSync(path.join(tmpDir, 'users/__init__.py'), '');
    fs.writeFileSync(
      path.join(tmpDir, 'users/views.py'),
      'class UserListView:\n    def get(self, request): pass\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'users/urls.py'),
      'from django.urls import path\n' +
        'from users.views import UserListView\n' +
        'urlpatterns = [path("users/", UserListView.as_view(), name="user-list")]\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Route node exists
    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThan(0);
    const route = routes.find((n) => n.name === 'users/');
    expect(route).toBeDefined();

    // View class exists
    const classNodes = cg.getNodesByKind('class');
    const view = classNodes.find((n) => n.name === 'UserListView');
    expect(view).toBeDefined();

    // Edge route -> view exists
    const edges = cg.getOutgoingEdges(route!.id);
    const toView = edges.find((e) => e.target === view!.id);
    expect(toView).toBeDefined();
    expect(toView!.kind).toBe('references');

    cg.close();
  });
});

describe('Flask end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves stacked routes across @login_required to a view named after a builtin (index)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flask-'));
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask==3.0\n');
    fs.writeFileSync(
      path.join(tmpDir, 'app.py'),
      'from flask import Blueprint, render_template\n' +
        'from flask_login import login_required\n' +
        'bp = Blueprint("main", __name__)\n' +
        '\n' +
        '@bp.route("/", methods=["GET", "POST"])\n' +
        '@bp.route("/index", methods=["GET", "POST"])\n' +
        '@login_required\n' +
        'def index():\n' +
        '    return render_template("index.html")\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Both stacked @bp.route decorators are extracted (the second was previously
    // dropped because @login_required broke the "def must follow" assumption).
    const routes = cg.getNodesByKind('route');
    expect(routes.map((r) => r.name).sort()).toEqual(['GET /', 'GET /index']);

    // The view function exists even though its name is a Python builtin method.
    const fn = cg.getNodesByKind('function').find((n) => n.name === 'index');
    expect(fn).toBeDefined();

    // Both routes resolve to it — exercises the bare-name builtin guard, which
    // previously filtered the `index` reference as a builtin method.
    for (const route of routes) {
      const edges = cg.getOutgoingEdges(route.id);
      const toView = edges.find((e) => e.target === fn!.id && e.kind === 'references');
      expect(toView, `route ${route.name} should resolve to index()`).toBeDefined();
    }

    cg.close();
  });
});

describe('Flutter end-to-end — setState→build synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('synthesizes a handler→build edge when a State method calls setState', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flutter-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.dart'),
      'import "package:flutter/material.dart";\n' +
        'class CounterPage extends StatefulWidget {\n' +
        '  @override\n' +
        '  State<CounterPage> createState() => _CounterPageState();\n' +
        '}\n' +
        'class _CounterPageState extends State<CounterPage> {\n' +
        '  int _count = 0;\n' +
        '  void _increment() {\n' +
        '    setState(() {\n' +
        '      _count++;\n' +
        '    });\n' +
        '  }\n' +
        '  @override\n' +
        '  Widget build(BuildContext context) {\n' +
        '    return Text("$_count");\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const increment = methods.find((n) => n.name === '_increment');
    const build = methods.find((n) => n.name === 'build');
    expect(increment).toBeDefined();
    expect(build).toBeDefined();

    // setState re-runs build (Flutter-internal, no static edge). The synthesizer
    // bridges the handler → build so the "tap → setState → rebuilt UI" flow connects.
    const edges = cg.getOutgoingEdges(increment!.id);
    const toBuild = edges.find((e) => e.target === build!.id && e.kind === 'calls');
    expect(toBuild, '_increment should reach build via setState synthesis').toBeDefined();

    cg.close();
  });
});

describe('C++ end-to-end — virtual override synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('bridges a base virtual method to the subclass override', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'iter.cpp'),
      'class Iterator {\n' +
        ' public:\n' +
        '  virtual void Next() { }\n' +
        '};\n' +
        'class DBIter : public Iterator {\n' +
        ' public:\n' +
        '  void Next() override { advance(); }\n' +
        '  void advance() { }\n' +
        '};\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Two methods named Next: the base virtual (lower line) and the override.
    const nexts = cg
      .getNodesByKind('method')
      .filter((n) => n.name === 'Next')
      .sort((a, b) => a.startLine - b.startLine);
    expect(nexts.length).toBe(2);
    const [baseNext, overrideNext] = nexts;

    // A vtable call to Iterator::Next dispatches to DBIter::Next — bridge it so
    // trace/callees from the interface method reaches the implementation.
    const edge = cg
      .getOutgoingEdges(baseNext!.id)
      .find((e) => e.target === overrideNext!.id && e.kind === 'calls');
    expect(edge, 'Iterator::Next should reach DBIter::Next via override synthesis').toBeDefined();

    cg.close();
  });
});

describe('Bevy ECS state transition synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('synthesizes edges from NextState::Pending producers to in_state consumers', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-state-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(
      path.join(tmpDir, 'src/main.rs'),
      'use bevy::prelude::*;\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum GameState { #[default] Menu, Playing, GameOver }\n' +
        '\n' +
        'fn enter_playing(mut next_state: ResMut<NextState<GameState>>) {\n' +
        '    next_state.set(GameState::Playing);\n' +
        '}\n' +
        '\n' +
        'fn on_enter_playing() {\n' +
        '    // setup level\n' +
        '}\n' +
        '\n' +
        'fn check_state() {\n' +
        '    if in_state(GameState::Playing) {\n' +
        '        // do something\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const enterPlaying = fns.find((n) => n.name === 'enter_playing');
    const checkState = fns.find((n) => n.name === 'check_state');
    expect(enterPlaying).toBeDefined();
    expect(checkState).toBeDefined();

    // The producer (enter_playing) should have a synthesized calls edge to the consumer
    const edges = cg.getOutgoingEdges(enterPlaying!.id);
    const toConsumer = edges.find((e) => e.target === checkState!.id && e.kind === 'calls');
    expect(toConsumer, 'enter_playing should reach check_state via Bevy state synthesis').toBeDefined();

    // Verify provenance
    if (toConsumer) {
      expect(toConsumer.provenance).toBe('heuristic');
      expect((toConsumer.metadata as Record<string, unknown>)?.synthesizedBy).toBe('bevy-ecs-state');
    }

    cg.close();
  });

  it('ignores state patterns inside comments', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-comment-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(
      path.join(tmpDir, 'src/main.rs'),
      'fn producer(next_state: ResMut<NextState<GameState>>) {\n' +
        '    next_state.set(GameState::Playing);\n' +
        '}\n' +
        'fn consumer() {\n' +
        '    // TODO: next_state.set(GameState::Menu)\n' +
        '    if in_state(GameState::Playing) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const producer = fns.find((n) => n.name === 'producer');
    const consumer = fns.find((n) => n.name === 'consumer');

    // producer → consumer edge via GameState::Playing exists
    const edges = cg.getOutgoingEdges(producer!.id);
    const toConsumer = edges.find((e) => e.target === consumer!.id && e.kind === 'calls');
    expect(toConsumer).toBeDefined();

    // consumer should NOT have an outgoing edge (commented Menu is ignored)
    const consumerEdges = cg.getOutgoingEdges(consumer!.id).filter(e => e.kind === 'calls' && e.provenance === 'heuristic');
    expect(consumerEdges.length).toBe(0);

    cg.close();
  });

  it('matches qualified and unqualified state names', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-unqual-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(
      path.join(tmpDir, 'src/main.rs'),
      'fn producer(next_state: ResMut<NextState<GameState>>) {\n' +
        '    next_state.set(GameState::Playing);\n' +
        '}\n' +
        'fn consumer() {\n' +
        '    if in_state(Playing) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const producer = fns.find((n) => n.name === 'producer');
    const consumer = fns.find((n) => n.name === 'consumer');

    // Qualified (GameState::Playing) and unqualified (Playing) should match
    const edges = cg.getOutgoingEdges(producer!.id);
    const toConsumer = edges.find((e) => e.target === consumer!.id && e.kind === 'calls');
    expect(toConsumer, 'qualified→unqualified state name should still produce an edge').toBeDefined();

    cg.close();
  });

  it('does not match state patterns inside raw strings', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-raw-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(
      path.join(tmpDir, 'src/main.rs'),
      'fn producer(next_state: ResMut<NextState<GameState>>) {\n' +
      '    next_state.set(GameState::Playing);\n' +
      '}\n' +
      'fn consumer() {\n' +
      '    let desc = r#"next_state.set(GameState::Menu)"#;\n' +
      '    if in_state(GameState::Playing) {}\n' +
      '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const consumer = fns.find((n) => n.name === 'consumer');

    // consumer should NOT produce edges — the Menu pattern is inside a raw string
    const consumerEdges = cg.getOutgoingEdges(consumer!.id)
      .filter(e => e.kind === 'calls' && e.provenance === 'heuristic');
    expect(consumerEdges.length).toBe(0);

    cg.close();
  });

  it('does not match state patterns inside nested block comments', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-nested-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(
      path.join(tmpDir, 'src/main.rs'),
      'fn producer(next_state: ResMut<NextState<GameState>>) {\n' +
      '    next_state.set(GameState::Playing);\n' +
      '}\n' +
      'fn consumer() {\n' +
      '    /* outer /* inner */ next_state.set(GameState::GameOver); */\n' +
      '    if in_state(GameState::Playing) {}\n' +
      '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const consumer = fns.find((n) => n.name === 'consumer');

    // consumer should NOT produce edges — GameOver is inside nested comment
    const consumerEdges = cg.getOutgoingEdges(consumer!.id)
      .filter(e => e.kind === 'calls' && e.provenance === 'heuristic');
    expect(consumerEdges.length).toBe(0);

    cg.close();
  });

  it('does not produce cross-enum state edges', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-cross-enum-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(
      path.join(tmpDir, 'src/main.rs'),
      'fn producer(next_state: ResMut<NextState<GameState>>) {\n' +
      '    next_state.set(GameState::Playing);\n' +
      '}\n' +
      'fn consumer() {\n' +
      '    if in_state(UiState::Playing) {}\n' +
      '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const producer = fns.find((n) => n.name === 'producer');
    const consumer = fns.find((n) => n.name === 'consumer');

    // No edge: GameState::Playing ≠ UiState::Playing (both qualified, different enum)
    const edges = cg.getOutgoingEdges(producer!.id);
    const toConsumer = edges.find((e) => e.target === consumer!.id && e.kind === 'calls');
    expect(toConsumer).toBeUndefined();

    cg.close();
  });

  it('produces edge when only one side is qualified (same variant)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-one-qual-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(
      path.join(tmpDir, 'src/main.rs'),
      'fn producer(next_state: ResMut<NextState<GameState>>) {\n' +
      '    next_state.set(GameState::Playing);\n' +
      '}\n' +
      'fn consumer() {\n' +
      '    if in_state(Playing) {}\n' +
      '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const producer = fns.find((n) => n.name === 'producer');
    const consumer = fns.find((n) => n.name === 'consumer');

    // Qualified→unqualified should match (only one side is qualified)
    const edges = cg.getOutgoingEdges(producer!.id);
    const toConsumer = edges.find((e) => e.target === consumer!.id && e.kind === 'calls');
    expect(toConsumer).toBeDefined();

    cg.close();
  });
});
