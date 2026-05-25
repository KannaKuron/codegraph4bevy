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

    const edges = cg.getOutgoingEdges(finishIntro!.id);
    const toConsumer = edges.find((e) => e.target === onLoading!.id && e.kind === 'calls');
    expect(toConsumer, 'finish_intro should reach on_loading_complete via ComputedStates bridge').toBeDefined();

    if (toConsumer) {
      expect(toConsumer.provenance).toBe('heuristic');
      const meta = toConsumer.metadata as Record<string, unknown>;
      expect(meta?.synthesizedBy).toBe('bevy-ecs-state');
      expect(meta?.transitiveVia).toBe('IntroState');
    }

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

    const edges = cg.getOutgoingEdges(producer!.id);
    const toConsumer = edges.find((e) => e.target === consumer!.id && e.kind === 'calls');
    expect(toConsumer, 'CJK producer should reach CJK consumer via ComputedStates').toBeDefined();

    if (toConsumer) {
      const meta = toConsumer.metadata as Record<string, unknown>;
      expect(meta?.transitiveVia).toBe('片头播放_状态');
    }

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

    // Both source state producers should reach the computed state consumer
    const edgesA = cg.getOutgoingEdges(setADone!.id);
    const toReadyFromA = edgesA.find((e) => e.target === onReady!.id && e.kind === 'calls');
    expect(toReadyFromA, 'set_a_done should reach on_ready via tuple SourceStates').toBeDefined();

    const edgesB = cg.getOutgoingEdges(setBDone!.id);
    const toReadyFromB = edgesB.find((e) => e.target === onReady!.id && e.kind === 'calls');
    expect(toReadyFromB, 'set_b_done should reach on_ready via tuple SourceStates').toBeDefined();

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

    const edges = cg.getOutgoingEdges(finishIntro!.id);
    const toConsumer = edges.find((e) => e.target === onLoading!.id && e.kind === 'calls');
    expect(toConsumer, 'finish_intro should reach on_loading_complete even with fn before SourceStates').toBeDefined();

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

    const edges = cg.getOutgoingEdges(finishIntro!.id);
    const toConsumer = edges.find((e) => e.target === onLoading!.id && e.kind === 'calls');
    expect(toConsumer, 'qualified paths should normalize and bridge').toBeDefined();

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
});
