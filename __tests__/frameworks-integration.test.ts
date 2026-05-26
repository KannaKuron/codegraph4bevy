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

  it('bridges ComputedStates transitive edges', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-computed-'));
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
        'enum IntroState { #[default] Playing, Done }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum LoadingPhase { #[default] NotStarted, Complete }\n' +
        '\n' +
        'impl ComputedStates for LoadingPhase {\n' +
        '    type SourceStates = IntroState;\n' +
        '    fn compute(s: &Self::SourceStates) -> Option<Self> {\n' +
        '        match s { IntroState::Done => Some(LoadingPhase::Complete), _ => None }\n' +
        '    }\n' +
        '}\n' +
        '\n' +
        'fn finish_intro(mut next_state: ResMut<NextState<IntroState>>) {\n' +
        '    next_state.set(IntroState::Done);\n' +
        '}\n' +
        '\n' +
        'fn on_loading_complete() {\n' +
        '    if in_state(LoadingPhase::Complete) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const finishIntro = fns.find((n) => n.name === 'finish_intro');
    const onLoading = fns.find((n) => n.name === 'on_loading_complete');
    expect(finishIntro).toBeDefined();
    expect(onLoading).toBeDefined();

    // ComputedStates edges pass through the computed state node
    const enums = cg.getNodesByKind('enum');
    const loadingPhase = enums.find((n) => n.name === 'LoadingPhase');
    expect(loadingPhase, 'LoadingPhase enum node should exist').toBeDefined();

    // Step 1: finish_intro → LoadingPhase (source producer → computed state node)
    const edgesToComputed = cg.getOutgoingEdges(finishIntro!.id);
    const toComputed = edgesToComputed.find((e) => e.target === loadingPhase!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toComputed, 'finish_intro should reach LoadingPhase via ComputedStates').toBeDefined();
    expect((toComputed!.metadata as Record<string, unknown>)?.transitiveVia).toBe('IntroState');

    // Step 2: LoadingPhase → on_loading_complete (computed state node → consumer)
    const edgesFromComputed = cg.getOutgoingEdges(loadingPhase!.id);
    const toConsumer = edgesFromComputed.find((e) => e.target === onLoading!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toConsumer, 'LoadingPhase should reach on_loading_complete').toBeDefined();

    cg.close();
  });

  it('does not create transitive edges without ComputedStates impl', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-no-computed-'));
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
        '    if in_state(OtherState::Active) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const producer = fns.find((n) => n.name === 'producer');
    const consumer = fns.find((n) => n.name === 'consumer');

    const edges = cg.getOutgoingEdges(producer!.id);
    const toConsumer = edges.find((e) => e.target === consumer!.id && e.kind === 'calls');
    expect(toConsumer).toBeUndefined();

    cg.close();
  });

  it('bridges ComputedStates with CJK state names', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-cjk-'));
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
        'enum 片头播放_状态 { #[default] 播放中, 完成 }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum 开场与基础素材_加载_阶段完成 { #[default] 未完成, 完成 }\n' +
        '\n' +
        'impl ComputedStates for 开场与基础素材_加载_阶段完成 {\n' +
        '    type SourceStates = 片头播放_状态;\n' +
        '    fn compute(s: &Self::SourceStates) -> Option<Self> {\n' +
        '        match s { 片头播放_状态::完成 => Some(开场与基础素材_加载_阶段完成::完成), _ => None }\n' +
        '    }\n' +
        '}\n' +
        '\n' +
        'fn 更新_片头计时(mut next_state: ResMut<NextState<片头播放_状态>>) {\n' +
        '    next_state.set(片头播放_状态::完成);\n' +
        '}\n' +
        '\n' +
        'fn 生成_主菜单() {\n' +
        '    if in_state(开场与基础素材_加载_阶段完成::完成) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const producer = fns.find((n) => n.name === '更新_片头计时');
    const consumer = fns.find((n) => n.name === '生成_主菜单');
    expect(producer).toBeDefined();
    expect(consumer).toBeDefined();

    // ComputedStates edges pass through the computed state node
    const enums = cg.getNodesByKind('enum');
    const computedNode = enums.find((n) => n.name === '开场与基础素材_加载_阶段完成');
    expect(computedNode, 'computed state enum node should exist').toBeDefined();

    // Step 1: producer → computed state node
    const edgesToComputed = cg.getOutgoingEdges(producer!.id);
    const toComputed = edgesToComputed.find((e) => e.target === computedNode!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toComputed, 'CJK producer should reach computed state node').toBeDefined();
    expect((toComputed!.metadata as Record<string, unknown>)?.transitiveVia).toBe('片头播放_状态');

    // Step 2: computed state node → consumer
    const edgesFromComputed = cg.getOutgoingEdges(computedNode!.id);
    const toConsumer = edgesFromComputed.find((e) => e.target === consumer!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toConsumer, 'computed state node should reach CJK consumer').toBeDefined();

    cg.close();
  });

  it('bridges ComputedStates with tuple SourceStates', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-tuple-'));
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
        'enum StateA { #[default] Init, Done }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum StateB { #[default] Init, Done }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum CombinedState { #[default] Waiting, Ready }\n' +
        '\n' +
        'impl ComputedStates for CombinedState {\n' +
        '    type SourceStates = (StateA, StateB);\n' +
        '}\n' +
        '\n' +
        'fn set_a_done(mut next_state: ResMut<NextState<StateA>>) {\n' +
        '    next_state.set(StateA::Done);\n' +
        '}\n' +
        '\n' +
        'fn set_b_done(mut next_state: ResMut<NextState<StateB>>) {\n' +
        '    next_state.set(StateB::Done);\n' +
        '}\n' +
        '\n' +
        'fn on_ready() {\n' +
        '    if in_state(CombinedState::Ready) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const setADone = fns.find((n) => n.name === 'set_a_done');
    const setBDone = fns.find((n) => n.name === 'set_b_done');
    const onReady = fns.find((n) => n.name === 'on_ready');

    const enums = cg.getNodesByKind('enum');
    const combinedState = enums.find((n) => n.name === 'CombinedState');
    expect(combinedState, 'CombinedState enum node should exist').toBeDefined();

    // Both source producers reach the computed state node
    const edgesA = cg.getOutgoingEdges(setADone!.id);
    const toComputedFromA = edgesA.find((e) => e.target === combinedState!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toComputedFromA, 'set_a_done should reach CombinedState via tuple SourceStates').toBeDefined();

    const edgesB = cg.getOutgoingEdges(setBDone!.id);
    const toComputedFromB = edgesB.find((e) => e.target === combinedState!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toComputedFromB, 'set_b_done should reach CombinedState via tuple SourceStates').toBeDefined();

    // Computed state node reaches the consumer
    const edgesFromComputed = cg.getOutgoingEdges(combinedState!.id);
    const toReady = edgesFromComputed.find((e) => e.target === onReady!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toReady, 'CombinedState should reach on_ready').toBeDefined();

    cg.close();
  });

  it('extracts ComputedStates with nested fn body before SourceStates', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-nested-fn-'));
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
        'enum IntroState { #[default] Playing, Done }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum LoadingPhase { #[default] NotStarted, Complete }\n' +
        '\n' +
        'impl ComputedStates for LoadingPhase {\n' +
        '    fn compute(s: &Self::SourceStates) -> Option<Self> {\n' +
        '        match s { IntroState::Done => Some(LoadingPhase::Complete), _ => None }\n' +
        '    }\n' +
        '    type SourceStates = IntroState;\n' +
        '}\n' +
        '\n' +
        'fn finish_intro(mut next_state: ResMut<NextState<IntroState>>) {\n' +
        '    next_state.set(IntroState::Done);\n' +
        '}\n' +
        '\n' +
        'fn on_loading_complete() {\n' +
        '    if in_state(LoadingPhase::Complete) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const finishIntro = fns.find((n) => n.name === 'finish_intro');
    const onLoading = fns.find((n) => n.name === 'on_loading_complete');
    expect(finishIntro).toBeDefined();
    expect(onLoading).toBeDefined();

    const enums = cg.getNodesByKind('enum');
    const loadingPhase = enums.find((n) => n.name === 'LoadingPhase');

    // finish_intro → LoadingPhase → on_loading_complete (two-hop)
    const edgesToComputed = cg.getOutgoingEdges(finishIntro!.id);
    const toComputed = edgesToComputed.find((e) => e.target === loadingPhase!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toComputed, 'finish_intro should reach LoadingPhase even with fn before SourceStates').toBeDefined();

    const edgesFromComputed = cg.getOutgoingEdges(loadingPhase!.id);
    const toConsumer = edgesFromComputed.find((e) => e.target === onLoading!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toConsumer, 'LoadingPhase should reach on_loading_complete').toBeDefined();

    cg.close();
  });

  it('bridges ComputedStates with qualified :: paths', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-qualified-'));
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
        'enum IntroState { #[default] Playing, Done }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum LoadingPhase { #[default] NotStarted, Complete }\n' +
        '\n' +
        'impl ComputedStates for crate::LoadingPhase {\n' +
        '    type SourceStates = crate::IntroState;\n' +
        '}\n' +
        '\n' +
        'fn finish_intro(mut next_state: ResMut<NextState<IntroState>>) {\n' +
        '    next_state.set(IntroState::Done);\n' +
        '}\n' +
        '\n' +
        'fn on_loading_complete() {\n' +
        '    if in_state(LoadingPhase::Complete) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const finishIntro = fns.find((n) => n.name === 'finish_intro');
    const onLoading = fns.find((n) => n.name === 'on_loading_complete');
    expect(finishIntro).toBeDefined();
    expect(onLoading).toBeDefined();

    const enums = cg.getNodesByKind('enum');
    const loadingPhase = enums.find((n) => n.name === 'LoadingPhase');

    // Two-hop: finish_intro → LoadingPhase → on_loading_complete
    const edgesToComputed = cg.getOutgoingEdges(finishIntro!.id);
    const toComputed = edgesToComputed.find((e) => e.target === loadingPhase!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toComputed, 'qualified paths should normalize and bridge to computed state node').toBeDefined();

    const edgesFromComputed = cg.getOutgoingEdges(loadingPhase!.id);
    const toConsumer = edgesFromComputed.find((e) => e.target === onLoading!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toConsumer, 'computed state node should reach consumer').toBeDefined();

    cg.close();
  });

  it('handles same-variant collision across different enums', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-collision-'));
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
        'enum StateA { #[default] Init, Done }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum StateB { #[default] Init, Done }\n' +
        '\n' +
        'fn set_state_a(mut next_state: ResMut<NextState<StateA>>) {\n' +
        '    next_state.set(StateA::Done);\n' +
        '}\n' +
        '\n' +
        'fn set_state_b(mut next_state: ResMut<NextState<StateB>>) {\n' +
        '    next_state.set(StateB::Done);\n' +
        '}\n' +
        '\n' +
        'fn on_a_done() {\n' +
        '    if in_state(StateA::Done) {}\n' +
        '}\n' +
        '\n' +
        'fn on_b_done() {\n' +
        '    if in_state(StateB::Done) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const setStateA = fns.find((n) => n.name === 'set_state_a');
    const setStateB = fns.find((n) => n.name === 'set_state_b');
    const onADone = fns.find((n) => n.name === 'on_a_done');
    const onBDone = fns.find((n) => n.name === 'on_b_done');

    // set_state_a → on_a_done (same enum, same variant)
    const edgesA = cg.getOutgoingEdges(setStateA!.id);
    const toADone = edgesA.find((e) => e.target === onADone!.id && e.kind === 'calls');
    expect(toADone, 'set_state_a should reach on_a_done').toBeDefined();

    // set_state_b → on_b_done (same enum, same variant)
    const edgesB = cg.getOutgoingEdges(setStateB!.id);
    const toBDone = edgesB.find((e) => e.target === onBDone!.id && e.kind === 'calls');
    expect(toBDone, 'set_state_b should reach on_b_done').toBeDefined();

    // Cross-enum: set_state_a should NOT reach on_b_done
    const crossAB = edgesA.find((e) => e.target === onBDone!.id && e.kind === 'calls');
    expect(crossAB, 'set_state_a should NOT reach on_b_done (different enum)').toBeUndefined();

    // Cross-enum: set_state_b should NOT reach on_a_done
    const crossBA = edgesB.find((e) => e.target === onADone!.id && e.kind === 'calls');
    expect(crossBA, 'set_state_b should NOT reach on_a_done (different enum)').toBeUndefined();

    cg.close();
  });

  it('handles tuple SourceStates with generic type parameters', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-tuple-generic-'));
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
        'enum SplineState { #[default] Init, Ready }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum Interpolation { #[default] Init, Active }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum CombinedState { #[default] Waiting, Ready }\n' +
        '\n' +
        'impl ComputedStates for CombinedState {\n' +
        '    type SourceStates = (Spline<f32>, Interpolation);\n' +
        '}\n' +
        '\n' +
        'fn set_spline(mut next_state: ResMut<NextState<SplineState>>) {\n' +
        '    next_state.set(SplineState::Ready);\n' +
        '}\n' +
        '\n' +
        'fn on_ready() {\n' +
        '    if in_state(CombinedState::Ready) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const setSpline = fns.find((n) => n.name === 'set_spline');
    const onReady = fns.find((n) => n.name === 'on_ready');

    // Should not crash; Spline<f32> won't match SplineState (different name),
    // so no transitive edge expected — just verify no crash and no wrong edge.
    expect(setSpline).toBeDefined();
    expect(onReady).toBeDefined();

    // No edge expected because Spline<f32> ≠ SplineState
    const edges = cg.getOutgoingEdges(setSpline!.id);
    const toReady = edges.find((e) => e.target === onReady!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toReady).toBeUndefined();

    cg.close();
  });

  it('direct edges have priority over transitive', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-direct-prio-'));
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
        'enum IntroState { #[default] Playing, Done }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum LoadingPhase { #[default] NotStarted, Complete }\n' +
        '\n' +
        'impl ComputedStates for LoadingPhase {\n' +
        '    type SourceStates = IntroState;\n' +
        '}\n' +
        '\n' +
        'fn finish_intro(mut next_state: ResMut<NextState<IntroState>>) {\n' +
        '    next_state.set(IntroState::Done);\n' +
        '}\n' +
        '\n' +
        // Consumer watches IntroState::Done directly (not a computed state),
        // so the direct edge should be preferred over the transitive one.
        'fn on_intro_done() {\n' +
        '    if in_state(IntroState::Done) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const finishIntro = fns.find((n) => n.name === 'finish_intro');
    const onIntroDone = fns.find((n) => n.name === 'on_intro_done');
    expect(finishIntro).toBeDefined();
    expect(onIntroDone).toBeDefined();

    const edges = cg.getOutgoingEdges(finishIntro!.id);
    const toConsumer = edges.find((e) => e.target === onIntroDone!.id && e.kind === 'calls');
    expect(toConsumer, 'finish_intro should reach on_intro_done').toBeDefined();

    if (toConsumer) {
      const meta = toConsumer.metadata as Record<string, unknown>;
      // Direct edge should not have transitiveVia
      expect(meta?.transitiveVia).toBeUndefined();
    }

    cg.close();
  });

  it('handles unclosed raw string without truncating earlier content', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-unclosed-raw-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(
      path.join(tmpDir, 'src/main.rs'),
      // Producer and consumer are BEFORE the unclosed raw string.
      // The fix ensures the stripper replaces the remainder with spaces
      // (preserving newlines) instead of truncating the output entirely.
      'fn producer(next_state: ResMut<NextState<GameState>>) {\n' +
        '    next_state.set(GameState::Playing);\n' +
        '}\n' +
        'fn consumer() {\n' +
        '    if in_state(GameState::Playing) {}\n' +
        '}\n' +
        'fn unrelated() {\n' +
        '    let _s = r#"never_closed;\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const producer = fns.find((n) => n.name === 'producer');
    const consumer = fns.find((n) => n.name === 'consumer');
    expect(producer).toBeDefined();
    expect(consumer).toBeDefined();

    // Content before the unclosed raw string should be processed correctly
    const edges = cg.getOutgoingEdges(producer!.id);
    const toConsumer = edges.find((e) => e.target === consumer!.id && e.kind === 'calls');
    expect(toConsumer, 'producer should reach consumer — content before unclosed raw string preserved').toBeDefined();

    cg.close();
  });

  it('OnEnter registers handler as state consumer', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-onenter-'));
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
        'enum GameState { #[default] Menu, Playing }\n' +
        '\n' +
        'fn start_game(mut next_state: ResMut<NextState<GameState>>) {\n' +
        '    next_state.set(GameState::Playing);\n' +
        '}\n' +
        '\n' +
        'fn spawn_player() {\n' +
        '    // setup\n' +
        '}\n' +
        '\n' +
        'struct GamePlugin;\n' +
        'impl Plugin for GamePlugin {\n' +
        '    fn build(&self, app: &mut App) {\n' +
        '        app.add_systems(OnEnter(GameState::Playing), spawn_player);\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const startGame = fns.find((n) => n.name === 'start_game');
    const spawnPlayer = fns.find((n) => n.name === 'spawn_player');
    expect(startGame).toBeDefined();
    expect(spawnPlayer).toBeDefined();

    const edges = cg.getOutgoingEdges(startGame!.id);
    const toSpawn = edges.find((e) => e.target === spawnPlayer!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toSpawn, 'OnEnter handler should be reachable from state producer').toBeDefined();
    expect((toSpawn!.metadata as Record<string, unknown>)?.synthesizedBy).toBe('bevy-ecs-state');
    expect((toSpawn!.metadata as Record<string, unknown>)?.stateName).toBe('Playing');

    cg.close();
  });

  it('OnExit registers handler as state consumer', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-onexit-'));
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
        'enum GameState { #[default] Menu, Playing }\n' +
        '\n' +
        'fn end_game(mut next_state: ResMut<NextState<GameState>>) {\n' +
        '    next_state.set(GameState::Menu);\n' +
        '}\n' +
        '\n' +
        'fn cleanup_level() {\n' +
        '    // teardown\n' +
        '}\n' +
        '\n' +
        'struct GamePlugin;\n' +
        'impl Plugin for GamePlugin {\n' +
        '    fn build(&self, app: &mut App) {\n' +
        '        app.add_systems(OnExit(GameState::Playing), cleanup_level);\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const endGame = fns.find((n) => n.name === 'end_game');
    const cleanupLevel = fns.find((n) => n.name === 'cleanup_level');
    expect(endGame).toBeDefined();
    expect(cleanupLevel).toBeDefined();

    // end_game sets Menu; cleanup_level is OnExit(Playing). Different variants, no edge.
    const edges = cg.getOutgoingEdges(endGame!.id);
    const toCleanup = edges.find((e) => e.target === cleanupLevel!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toCleanup, 'different variant: Menu producer should not reach Playing OnExit').toBeUndefined();

    cg.close();
  });

  it('bridges ComputedStates via OnEnter handler (N11 regression)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-cs-onenter-'));
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
        'enum IntroState { #[default] Playing, Done }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum LoadingPhase { #[default] NotStarted, Complete }\n' +
        '\n' +
        'impl ComputedStates for LoadingPhase {\n' +
        '    type SourceStates = IntroState;\n' +
        '}\n' +
        '\n' +
        'fn finish_intro(mut next_state: ResMut<NextState<IntroState>>) {\n' +
        '    next_state.set(IntroState::Done);\n' +
        '}\n' +
        '\n' +
        'fn on_loading_complete() {\n' +
        '    // setup\n' +
        '}\n' +
        '\n' +
        'struct MyPlugin;\n' +
        'impl Plugin for MyPlugin {\n' +
        '    fn build(&self, app: &mut App) {\n' +
        '        app.add_systems(OnEnter(LoadingPhase::Complete), on_loading_complete);\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const finishIntro = fns.find((n) => n.name === 'finish_intro');
    const onLoading = fns.find((n) => n.name === 'on_loading_complete');
    expect(finishIntro).toBeDefined();
    expect(onLoading).toBeDefined();

    const enums = cg.getNodesByKind('enum');
    const loadingPhase = enums.find((n) => n.name === 'LoadingPhase');

    // Two-hop: finish_intro → LoadingPhase → on_loading_complete
    const edgesToComputed = cg.getOutgoingEdges(finishIntro!.id);
    const toComputed = edgesToComputed.find((e) => e.target === loadingPhase!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toComputed, 'finish_intro should reach LoadingPhase via ComputedStates').toBeDefined();
    expect((toComputed!.metadata as Record<string, unknown>)?.transitiveVia).toBe('IntroState');

    const edgesFromComputed = cg.getOutgoingEdges(loadingPhase!.id);
    const toConsumer = edgesFromComputed.find((e) => e.target === onLoading!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toConsumer, 'LoadingPhase should reach OnEnter handler').toBeDefined();

    cg.close();
  });

  it('handles CJK state names in OnEnter registration', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-cjk-'));
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
        'enum 片头状态 { #[default] 播放中, 完成 }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum 加载阶段 { #[default] 未开始, 完成 }\n' +
        '\n' +
        'impl ComputedStates for 加载阶段 {\n' +
        '    type SourceStates = 片头状态;\n' +
        '}\n' +
        '\n' +
        'fn 更新_片头计时(mut next_state: ResMut<NextState<片头状态>>) {\n' +
        '    next_state.set(片头状态::完成);\n' +
        '}\n' +
        '\n' +
        'fn 生成_主菜单() {\n' +
        '    // setup\n' +
        '}\n' +
        '\n' +
        'struct MyPlugin;\n' +
        'impl Plugin for MyPlugin {\n' +
        '    fn build(&self, app: &mut App) {\n' +
        '        app.add_systems(OnEnter(加载阶段::完成), 生成_主菜单);\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const updateTimer = fns.find((n) => n.name === '更新_片头计时');
    const spawnMenu = fns.find((n) => n.name === '生成_主菜单');
    expect(updateTimer).toBeDefined();
    expect(spawnMenu).toBeDefined();

    const enums = cg.getNodesByKind('enum');
    const loadingPhase = enums.find((n) => n.name === '加载阶段');

    // Two-hop: 更新_片头计时 → 加载阶段 → 生成_主菜单
    const edgesToComputed = cg.getOutgoingEdges(updateTimer!.id);
    const toComputed = edgesToComputed.find((e) => e.target === loadingPhase!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toComputed, 'CJK state names should bridge to computed state node').toBeDefined();

    const edgesFromComputed = cg.getOutgoingEdges(loadingPhase!.id);
    const toSpawn = edgesFromComputed.find((e) => e.target === spawnMenu!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toSpawn, 'computed state node should reach CJK OnEnter handler').toBeDefined();

    cg.close();
  });

  it('detects multiple OnEnter handlers in chained add_systems', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-chain-'));
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
        'fn start_game(mut next_state: ResMut<NextState<GameState>>) {\n' +
        '    next_state.set(GameState::Playing);\n' +
        '}\n' +
        '\n' +
        'fn end_game(mut next_state: ResMut<NextState<GameState>>) {\n' +
        '    next_state.set(GameState::GameOver);\n' +
        '}\n' +
        '\n' +
        'fn spawn_player() {}\n' +
        'fn show_game_over() {}\n' +
        '\n' +
        'struct GamePlugin;\n' +
        'impl Plugin for GamePlugin {\n' +
        '    fn build(&self, app: &mut App) {\n' +
        '        app.add_systems(OnEnter(GameState::Playing), spawn_player)\n' +
        '           .add_systems(OnEnter(GameState::GameOver), show_game_over);\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const startGame = fns.find((n) => n.name === 'start_game');
    const endGame = fns.find((n) => n.name === 'end_game');
    const spawnPlayer = fns.find((n) => n.name === 'spawn_player');
    const showGameOver = fns.find((n) => n.name === 'show_game_over');

    expect(startGame).toBeDefined();
    expect(endGame).toBeDefined();

    // start_game → spawn_player (OnEnter Playing)
    const edgesStart = cg.getOutgoingEdges(startGame!.id);
    const toSpawn = edgesStart.find((e) => e.target === spawnPlayer!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toSpawn, 'start_game should reach spawn_player via OnEnter(Playing)').toBeDefined();

    // end_game → show_game_over (OnEnter GameOver)
    const edgesEnd = cg.getOutgoingEdges(endGame!.id);
    const toGameOver = edgesEnd.find((e) => e.target === showGameOver!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toGameOver, 'end_game should reach show_game_over via OnEnter(GameOver)').toBeDefined();

    // Cross-variant: start_game should NOT reach show_game_over
    const cross = edgesStart.find((e) => e.target === showGameOver!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(cross, 'start_game should NOT reach show_game_over (different variant)').toBeUndefined();

    cg.close();
  });

  it('traces two-step chain: ComputedStates OnEnter handler produces next state', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-e2e-'));
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
        'enum IntroState { #[default] Playing, Done }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum LoadingPhase { #[default] NotStarted, Complete }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum GameState { #[default] Menu, Playing }\n' +
        '\n' +
        'impl ComputedStates for LoadingPhase {\n' +
        '    type SourceStates = IntroState;\n' +
        '}\n' +
        '\n' +
        'fn finish_intro(mut next_state: ResMut<NextState<IntroState>>) {\n' +
        '    next_state.set(IntroState::Done);\n' +
        '}\n' +
        '\n' +
        'fn on_loading_complete(mut next_state: ResMut<NextState<GameState>>) {\n' +
        '    next_state.set(GameState::Playing);\n' +
        '}\n' +
        '\n' +
        'fn spawn_player() {\n' +
        '    // setup\n' +
        '}\n' +
        '\n' +
        'struct MyPlugin;\n' +
        'impl Plugin for MyPlugin {\n' +
        '    fn build(&self, app: &mut App) {\n' +
        '        app.add_systems(OnEnter(LoadingPhase::Complete), on_loading_complete)\n' +
        '           .add_systems(OnEnter(GameState::Playing), spawn_player);\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const finishIntro = fns.find((n) => n.name === 'finish_intro');
    const onLoading = fns.find((n) => n.name === 'on_loading_complete');
    const spawnPlayer = fns.find((n) => n.name === 'spawn_player');
    expect(finishIntro).toBeDefined();
    expect(onLoading).toBeDefined();
    expect(spawnPlayer).toBeDefined();

    const enums = cg.getNodesByKind('enum');
    const loadingPhase = enums.find((n) => n.name === 'LoadingPhase');

    // Step 1a: finish_intro → LoadingPhase (source producer → computed state node)
    const edgesToComputed = cg.getOutgoingEdges(finishIntro!.id);
    const toComputed = edgesToComputed.find((e) => e.target === loadingPhase!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toComputed, 'finish_intro should reach LoadingPhase via ComputedStates').toBeDefined();

    // Step 1b: LoadingPhase → on_loading_complete (computed state node → consumer)
    const edgesFromComputed = cg.getOutgoingEdges(loadingPhase!.id);
    const toLoading = edgesFromComputed.find((e) => e.target === onLoading!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toLoading, 'LoadingPhase should reach on_loading_complete').toBeDefined();

    // Step 2: on_loading_complete (GameState producer) → spawn_player
    //         (GameState consumer via OnEnter)
    const edgesStep2 = cg.getOutgoingEdges(onLoading!.id);
    const toSpawn = edgesStep2.find((e) => e.target === spawnPlayer!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toSpawn, 'on_loading_complete should reach spawn_player via OnEnter(GameState::Playing)').toBeDefined();

    cg.close();
  });

  it('bridges SubStates virtual producer to default variant OnEnter handler', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-substates-'));
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
        'enum ParentState { #[default] Init, Active }\n' +
        '\n' +
        '#[derive(SubStates, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        '#[source(ParentState = ParentState::Active)]\n' +
        'enum ChildState { #[default] Running, Paused }\n' +
        '\n' +
        'fn activate(mut next_state: ResMut<NextState<ParentState>>) {\n' +
        '    next_state.set(ParentState::Active);\n' +
        '}\n' +
        '\n' +
        'fn on_child_running() {\n' +
        '    // setup\n' +
        '}\n' +
        '\n' +
        'struct MyPlugin;\n' +
        'impl Plugin for MyPlugin {\n' +
        '    fn build(&self, app: &mut App) {\n' +
        '        app.add_systems(OnEnter(ChildState::Running), on_child_running);\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const activate = fns.find((n) => n.name === 'activate');
    const onRunning = fns.find((n) => n.name === 'on_child_running');
    expect(activate).toBeDefined();
    expect(onRunning).toBeDefined();

    const edges = cg.getOutgoingEdges(activate!.id);
    const toHandler = edges.find((e) => e.target === onRunning!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toHandler, 'activate should reach on_child_running via SubStates virtual producer').toBeDefined();
    expect((toHandler!.metadata as Record<string, unknown>)?.synthesizedBy).toBe('bevy-ecs-state');

    cg.close();
  });

  it('bridges SubStates with CJK state names (P-1 pattern)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-substates-cjk-'));
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
        'enum 游戏流程_状态 { #[default] 初始化, 开场与基础素材_加载 }\n' +
        '\n' +
        '#[derive(SubStates, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        '#[source(游戏流程_状态 = 游戏流程_状态::开场与基础素材_加载)]\n' +
        'enum 片头播放_状态 { #[default] 播放中, 完成 }\n' +
        '\n' +
        'fn 开始_初始化(mut next_state: ResMut<NextState<游戏流程_状态>>) {\n' +
        '    next_state.set(游戏流程_状态::开场与基础素材_加载);\n' +
        '}\n' +
        '\n' +
        'fn 生成_片头() {\n' +
        '    // setup\n' +
        '}\n' +
        '\n' +
        'struct MyPlugin;\n' +
        'impl Plugin for MyPlugin {\n' +
        '    fn build(&self, app: &mut App) {\n' +
        '        app.add_systems(OnEnter(片头播放_状态::播放中), 生成_片头);\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const init = fns.find((n) => n.name === '开始_初始化');
    const spawn = fns.find((n) => n.name === '生成_片头');
    expect(init).toBeDefined();
    expect(spawn).toBeDefined();

    const edges = cg.getOutgoingEdges(init!.id);
    const toSpawn = edges.find((e) => e.target === spawn!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toSpawn, '开始_初始化 should reach 生成_片头 via SubStates CJK virtual producer').toBeDefined();

    cg.close();
  });

  it('does not bridge SubStates for wrong parent variant', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-substates-wrong-'));
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
        'enum ParentState { #[default] Init, Active, Inactive }\n' +
        '\n' +
        '#[derive(SubStates, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        '#[source(ParentState = ParentState::Active)]\n' +
        'enum ChildState { #[default] Running, Paused }\n' +
        '\n' +
        'fn deactivate(mut next_state: ResMut<NextState<ParentState>>) {\n' +
        '    next_state.set(ParentState::Inactive);\n' +
        '}\n' +
        '\n' +
        'fn on_child_running() {\n' +
        '    // setup\n' +
        '}\n' +
        '\n' +
        'struct MyPlugin;\n' +
        'impl Plugin for MyPlugin {\n' +
        '    fn build(&self, app: &mut App) {\n' +
        '        app.add_systems(OnEnter(ChildState::Running), on_child_running);\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const deactivate = fns.find((n) => n.name === 'deactivate');
    const onRunning = fns.find((n) => n.name === 'on_child_running');
    expect(deactivate).toBeDefined();
    expect(onRunning).toBeDefined();

    const edges = cg.getOutgoingEdges(deactivate!.id);
    const toHandler = edges.find((e) => e.target === onRunning!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toHandler, 'deactivate sets Inactive, should NOT reach ChildState Running handler').toBeUndefined();

    cg.close();
  });

  it('bridges multiple SubStates sharing same parent variant', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-substates-multi-'));
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
        'enum ParentState { #[default] Init, Active }\n' +
        '\n' +
        '#[derive(SubStates, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        '#[source(ParentState = ParentState::Active)]\n' +
        'enum SubA { #[default] DefaultA, OtherA }\n' +
        '\n' +
        '#[derive(SubStates, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        '#[source(ParentState = ParentState::Active)]\n' +
        'enum SubB { #[default] DefaultB, OtherB }\n' +
        '\n' +
        'fn activate(mut next_state: ResMut<NextState<ParentState>>) {\n' +
        '    next_state.set(ParentState::Active);\n' +
        '}\n' +
        '\n' +
        'fn on_sub_a() {}\n' +
        'fn on_sub_b() {}\n' +
        '\n' +
        'struct MyPlugin;\n' +
        'impl Plugin for MyPlugin {\n' +
        '    fn build(&self, app: &mut App) {\n' +
        '        app.add_systems(OnEnter(SubA::DefaultA), on_sub_a)\n' +
        '           .add_systems(OnEnter(SubB::DefaultB), on_sub_b);\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const activate = fns.find((n) => n.name === 'activate');
    const onSubA = fns.find((n) => n.name === 'on_sub_a');
    const onSubB = fns.find((n) => n.name === 'on_sub_b');
    expect(activate).toBeDefined();
    expect(onSubA).toBeDefined();
    expect(onSubB).toBeDefined();

    const edges = cg.getOutgoingEdges(activate!.id);

    const toSubA = edges.find((e) => e.target === onSubA!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toSubA, 'activate should reach on_sub_a via SubA virtual producer').toBeDefined();

    const toSubB = edges.find((e) => e.target === onSubB!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toSubB, 'activate should reach on_sub_b via SubB virtual producer').toBeDefined();

    cg.close();
  });

  it('bridges SubStates + ComputedStates end-to-end chain', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bevy-substates-e2e-'));
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
        'enum ParentState { #[default] Init, Active }\n' +
        '\n' +
        '#[derive(SubStates, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        '#[source(ParentState = ParentState::Active)]\n' +
        'enum ChildState { #[default] Running, Done }\n' +
        '\n' +
        '#[derive(States, Default, Clone, Eq, PartialEq, Hash, Debug)]\n' +
        'enum ComputedResult { #[default] Waiting, Ready }\n' +
        '\n' +
        'impl ComputedStates for ComputedResult {\n' +
        '    type SourceStates = ChildState;\n' +
        '}\n' +
        '\n' +
        'fn activate(mut next_state: ResMut<NextState<ParentState>>) {\n' +
        '    next_state.set(ParentState::Active);\n' +
        '}\n' +
        '\n' +
        'fn on_ready() {\n' +
        '    // setup\n' +
        '}\n' +
        '\n' +
        'struct MyPlugin;\n' +
        'impl Plugin for MyPlugin {\n' +
        '    fn build(&self, app: &mut App) {\n' +
        '        app.add_systems(OnEnter(ComputedResult::Ready), on_ready);\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const activate = fns.find((n) => n.name === 'activate');
    const onReady = fns.find((n) => n.name === 'on_ready');
    expect(activate).toBeDefined();
    expect(onReady).toBeDefined();

    const enums = cg.getNodesByKind('enum');
    const computedResult = enums.find((n) => n.name === 'ComputedResult');

    // SubStates virtual producer: activate is a virtual producer of ChildState::Running
    // ComputedStates: ChildState → ComputedResult, so activate reaches ComputedResult node
    const edgesToComputed = cg.getOutgoingEdges(activate!.id);
    const toComputed = edgesToComputed.find((e) => e.target === computedResult!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toComputed, 'activate should reach ComputedResult via SubStates + ComputedStates chain').toBeDefined();
    const meta = toComputed!.metadata as Record<string, unknown>;
    expect(meta?.transitiveVia).toBe('ChildState');

    // ComputedResult node → on_ready consumer
    const edgesFromComputed = cg.getOutgoingEdges(computedResult!.id);
    const toReady = edgesFromComputed.find((e) => e.target === onReady!.id && e.kind === 'calls' && e.provenance === 'heuristic');
    expect(toReady, 'ComputedResult should reach on_ready').toBeDefined();

    cg.close();
  });
});
