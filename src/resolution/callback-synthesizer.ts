/**
 * Callback / observer edge synthesis — Phase 1 + 2.
 *
 * Closes dynamic-dispatch holes where a dispatcher invokes callbacks registered
 * elsewhere. Two channel shapes:
 *
 *  (1) Field-backed observer (Phase 1):
 *      onUpdate(cb) { this.callbacks.add(cb); }            // registrar
 *      triggerUpdate() { for (cb of this.callbacks) cb(); } // dispatcher
 *      scene.onUpdate(this.triggerRender)                  // registration
 *      → synthesize triggerUpdate → triggerRender
 *
 *  (2) String-keyed EventEmitter (Phase 2):
 *      this.on('mount', function onmount(){...})           // registration
 *      fn.emit('mount', this)                              // dispatch
 *      → synthesize (method containing emit('mount')) → onmount
 *
 * Whole-graph pass after base resolution. High-precision/low-recall by design:
 * named callbacks only; field channels paired by file+field; EventEmitter
 * channels capped by event fan-out (generic names like 'error' skipped — they
 * need receiver-type matching, deferred to Phase 3). All synthesized edges are
 * tagged `provenance:'heuristic'`. See docs/design/callback-edge-synthesis.md.
 */
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';

const REGISTRAR_NAME = /^(on[A-Z]\w*|subscribe|addListener|addEventListener|register|watch|listen|addCallback)$/;
const DISPATCHER_NAME = /(emit|trigger|notify|dispatch|fire|publish|flush)/i;
const MAX_CALLBACKS_PER_CHANNEL = 40;
const EVENT_FANOUT_CAP = 6; // skip events with more handlers/dispatchers than this (too generic without type info)

const ON_RE = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*(?:function\s+(\w+)|(?:this\.)?(\w+))/g;
const EMIT_RE = /\.(?:emit|fire|dispatchEvent)\(\s*['"]([^'"]+)['"]/g;
const SETSTATE_RE = /this\.setState\s*\(/;
const FLUTTER_SETSTATE_RE = /\bsetState\s*\(/; // Flutter: setState((){…}) / this.setState
const JSX_TAG_RE = /<([A-Z][A-Za-z0-9_]*)[\s/>]/g;
const MAX_JSX_CHILDREN = 30;
// Vue SFC templates: kebab-case child components (<el-button> → ElButton) and
// event bindings (@click="fn" / v-on:click="fn"). PascalCase children (<VPNav/>)
// are already caught by JSX_TAG_RE via the SFC component node.
const VUE_KEBAB_RE = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g;
const VUE_HANDLER_RE = /(?:@|v-on:)([a-zA-Z][\w-]*)(?:\.[\w]+)*\s*=\s*"([^"]+)"/g;
// Composable/hook destructure: `const { close: closeSidebar } = useSidebarControl()`.
// Captures the destructure body + the called composable; only `use*` calls qualify.
const VUE_DESTRUCTURE_RE = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(\w+)\s*\(/g;

function kebabToPascal(s: string): string {
  return s.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

function sliceLines(content: string, startLine?: number, endLine?: number): string | null {
  if (!startLine || !endLine) return null;
  return content.split('\n').slice(startLine - 1, endLine).join('\n');
}

function registrarField(src: string): string | null {
  const m = src.match(/this\.(\w+)\.(?:add|push|set)\(/);
  return m ? m[1]! : null;
}

function dispatcherField(src: string): string | null {
  const forOf = src.match(/\bof\s+(?:Array\.from\(\s*)?this\.(\w+)/);
  if (forOf && /\b\w+\s*\(/.test(src)) return forOf[1]!;
  const forEach = src.match(/this\.(\w+)\.forEach\(/);
  if (forEach) return forEach[1]!;
  return null;
}

const FN_KINDS = new Set(['method', 'function', 'component']);

/** Innermost function/method node whose line range contains `line`. */
function enclosingFn(nodesInFile: Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const n of nodesInFile) {
    if (!FN_KINDS.has(n.kind)) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= line && end >= line) {
      if (!best || n.startLine >= best.startLine) best = n; // prefer the tightest (latest-starting) encloser
    }
  }
  return best;
}

/** Phase 1: field-backed observer channels (registrar/dispatcher share a store). */
function fieldChannelEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const candidates = [...queries.getNodesByKind('method'), ...queries.getNodesByKind('function')];
  const registrars: Array<{ node: Node; field: string }> = [];
  const dispatchers: Array<{ node: Node; field: string }> = [];

  for (const m of candidates) {
    const isReg = REGISTRAR_NAME.test(m.name);
    const isDisp = DISPATCHER_NAME.test(m.name);
    if (!isReg && !isDisp) continue;
    const content = ctx.readFile(m.filePath);
    const src = content && sliceLines(content, m.startLine, m.endLine);
    if (!src) continue;
    if (isReg) { const f = registrarField(src); if (f) registrars.push({ node: m, field: f }); }
    if (isDisp) { const f = dispatcherField(src); if (f) dispatchers.push({ node: m, field: f }); }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const reg of registrars) {
    const chDispatchers = dispatchers.filter(
      (d) => d.node.filePath === reg.node.filePath && d.field === reg.field
    );
    if (chDispatchers.length === 0) continue;
    const argRe = new RegExp(`${reg.node.name}\\s*\\(\\s*(?:this\\.)?(\\w+)`);
    let added = 0;
    for (const e of queries.getIncomingEdges(reg.node.id, ['calls'])) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (!e.line) continue;
      const caller = queries.getNodeById(e.source);
      if (!caller) continue;
      const line = ctx.readFile(caller.filePath)?.split('\n')[e.line - 1];
      const am = line?.match(argRe);
      if (!am) continue;
      const fn = ctx.getNodesByName(am[1]!).find((n) => n.kind === 'method' || n.kind === 'function');
      if (!fn) continue;
      for (const disp of chDispatchers) {
        if (disp.node.id === fn.id) continue;
        const key = `${disp.node.id}>${fn.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.node.id, target: fn.id, kind: 'calls', line: disp.node.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'callback', via: reg.node.name, field: reg.field,
            // Where the callback was wired up (`scene.onUpdate(this.triggerRender)`).
            // This is the #1 thing an agent reads/greps to explain the flow — surface
            // it so node/trace/context can show it without a callers() + Read round-trip.
            registeredAt: `${caller.filePath}:${e.line}`,
          },
        });
        added++;
      }
    }
  }
  return edges;
}

/** Phase 2: string-keyed EventEmitter channels (on('e', fn) ↔ emit('e')). */
function eventEmitterEdges(ctx: ResolutionContext): Edge[] {
  const emitsByEvent = new Map<string, Set<string>>();          // event → dispatcher node ids
  const handlersByEvent = new Map<string, Map<string, string>>(); // event → handler id → registration site (file:line)

  for (const file of ctx.getAllFiles()) {
    const content = ctx.readFile(file);
    if (!content) continue;
    const hasEmit = content.includes('.emit(') || content.includes('.fire(') || content.includes('.dispatchEvent(');
    const hasOn = content.includes('.on(') || content.includes('.once(') || content.includes('.addListener(');
    if (!hasEmit && !hasOn) continue;
    const nodesInFile = ctx.getNodesInFile(file);
    const lineOf = (idx: number) => content.slice(0, idx).split('\n').length;

    if (hasEmit) {
      EMIT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = EMIT_RE.exec(content))) {
        const disp = enclosingFn(nodesInFile, lineOf(m.index));
        if (!disp) continue;
        const set = emitsByEvent.get(m[1]!) ?? new Set<string>();
        set.add(disp.id); emitsByEvent.set(m[1]!, set);
      }
    }
    if (hasOn) {
      ON_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ON_RE.exec(content))) {
        const handlerName = m[2] || m[3];
        if (!handlerName) continue;
        const handler = ctx.getNodesByName(handlerName).find((n) => n.kind === 'function' || n.kind === 'method');
        if (!handler) continue;
        const map = handlersByEvent.get(m[1]!) ?? new Map<string, string>();
        map.set(handler.id, `${file}:${lineOf(m.index)}`); handlersByEvent.set(m[1]!, map);
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [event, dispatchers] of emitsByEvent) {
    const handlers = handlersByEvent.get(event);
    if (!handlers) continue;
    // Precision guard: a generic event name with many handlers/dispatchers can't
    // be matched without receiver-type info (Phase 3) — skip rather than over-link.
    if (dispatchers.size > EVENT_FANOUT_CAP || handlers.size > EVENT_FANOUT_CAP) continue;
    for (const d of dispatchers) for (const [h, registeredAt] of handlers) {
      if (d === h) continue;
      const key = `${d}>${h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: d, target: h, kind: 'calls', provenance: 'heuristic', metadata: { synthesizedBy: 'event-emitter', event, registeredAt } });
    }
  }
  return edges;
}

/**
 * Phase 4: React class-component re-render. `this.setState(...)` re-runs the
 * component's `render()`, but that hop is React-internal — no static edge — so a
 * flow like "mutation → setState → canvas repaint" dead-ends at setState even
 * though `render → getRenderableElements → …` is fully call-connected after it.
 * Bridge it: for each class that has a `render` method, link every sibling method
 * whose body calls `this.setState(` → `render`. The setState gate keeps this to
 * React class components (a non-React class with a `render` method won't call
 * `this.setState`). Over-approximation (all setState methods reach render) is
 * accepted — it's reachability-correct, like the callback channels.
 */
function reactRenderEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const cls of queries.getNodesByKind('class')) {
    const children = queries.getOutgoingEdges(cls.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    const render = children.find((n) => n.name === 'render');
    if (!render) continue;
    let added = 0;
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (m.id === render.id) continue;
      const content = ctx.readFile(m.filePath);
      const src = content && sliceLines(content, m.startLine, m.endLine);
      if (!src || !SETSTATE_RE.test(src)) continue;
      const key = `${m.id}>${render.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: m.id, target: render.id, kind: 'calls', line: m.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'react-render', via: 'setState', registeredAt: `${render.filePath}:${render.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/**
 * Phase 4b: Flutter setState → build (the Dart analog of react-render). In a
 * StatefulWidget's State class, `setState(() {…})` re-runs `build(context)`, but
 * that hop is framework-internal (Flutter calls build), so a flow like
 * "onPressed → _increment → setState → rebuilt UI" dead-ends at setState. Bridge
 * it: for each Dart class with a `build` method, link every sibling method whose
 * body calls `setState(` → `build`. The setState gate + `.dart` file keep this to
 * Flutter State classes. Over-approximation accepted (reachability-correct).
 */
function flutterBuildEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const cls of queries.getNodesByKind('class')) {
    const children = queries.getOutgoingEdges(cls.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    const build = children.find((n) => n.name === 'build');
    if (!build || !build.filePath.endsWith('.dart')) continue;
    let added = 0;
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (m.id === build.id) continue;
      const content = ctx.readFile(m.filePath);
      const src = content && sliceLines(content, m.startLine, m.endLine);
      if (!src || !FLUTTER_SETSTATE_RE.test(src)) continue;
      const key = `${m.id}>${build.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: m.id, target: build.id, kind: 'calls', line: m.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'flutter-build', via: 'setState', registeredAt: `${build.filePath}:${build.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/**
 * Phase 4c: C++ virtual override. A call through a base/interface pointer
 * (`db->Get(...)`, `iter->Next()`) dispatches at runtime to a subclass override,
 * but that hop is a vtable indirection — no static call edge — so a flow stops at
 * the abstract base method. Bridge it like react-render: for each C++ class that
 * `extends` a base, link each base method → the subclass method of the same name
 * (the override), so trace/callees from the interface method reach the
 * implementation(s). Over-approximation accepted (reachability-correct); capped
 * per class and gated to C++ to avoid touching other languages' dispatch.
 */
function cppOverrideEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const methodsOf = (classId: string): Node[] =>
    queries
      .getOutgoingEdges(classId, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
  for (const cls of queries.getNodesByKind('class')) {
    const subMethods = methodsOf(cls.id).filter((n) => n.language === 'cpp');
    if (subMethods.length === 0) continue;
    for (const ext of queries.getOutgoingEdges(cls.id, ['extends'])) {
      const base = queries.getNodeById(ext.target);
      if (!base || base.language !== 'cpp' || base.id === cls.id) continue;
      const baseMethods = new Map(methodsOf(base.id).map((m) => [m.name, m]));
      let added = 0;
      for (const m of subMethods) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        const bm = baseMethods.get(m.name);
        if (!bm || bm.id === m.id) continue;
        const key = `${bm.id}>${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: bm.id,
          target: m.id,
          kind: 'calls',
          line: bm.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'cpp-override', via: m.name, registeredAt: `${m.filePath}:${m.startLine}` },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * Phase 5.5: interface / abstract dispatch (Java, Kotlin). A call through an
 * injected interface (`@Autowired FooService svc; svc.list()`) or an abstract
 * base dispatches at runtime to the implementing class's override — a vtable
 * indirection with no static call edge — so a request→service flow stops at the
 * interface method. Bridge it like cpp-override: for each class that
 * `implements` an interface (or `extends` an abstract base), link each
 * base/interface method → the class's same-name method (the override) so
 * trace/callees reach the implementation. Over-approximation accepted
 * (reachability-correct); capped per class, gated to JVM languages.
 */
const IFACE_OVERRIDE_LANGS = new Set(['java', 'kotlin']);
function interfaceOverrideEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const methodsOf = (classId: string): Node[] =>
    queries
      .getOutgoingEdges(classId, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
  for (const cls of queries.getNodesByKind('class')) {
    const implMethods = methodsOf(cls.id).filter((n) => IFACE_OVERRIDE_LANGS.has(n.language));
    if (implMethods.length === 0) continue;
    for (const sup of queries.getOutgoingEdges(cls.id, ['implements', 'extends'])) {
      const base = queries.getNodeById(sup.target);
      if (!base || !IFACE_OVERRIDE_LANGS.has(base.language) || base.id === cls.id) continue;
      // Group impl methods by name to handle OVERLOADS: an interface `list()` and
      // `list(params)` are distinct nodes and a call may resolve to either, so
      // link every base overload → every same-name impl overload (keying by name
      // alone would drop all but one and miss the resolved overload).
      const implByName = new Map<string, Node[]>();
      for (const m of implMethods) {
        const arr = implByName.get(m.name);
        if (arr) arr.push(m); else implByName.set(m.name, [m]);
      }
      let added = 0;
      for (const bm of methodsOf(base.id)) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        for (const m of implByName.get(bm.name) ?? []) {
          if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
          if (bm.id === m.id) continue;
          const key = `${bm.id}>${m.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: bm.id,
            target: m.id,
            kind: 'calls',
            line: bm.startLine,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'interface-impl', via: m.name, registeredAt: `${m.filePath}:${m.startLine}` },
          });
          added++;
        }
      }
    }
  }
  return edges;
}

/**
 * Phase 5: React JSX child rendering. A component that returns `<Child .../>`
 * mounts Child — React calls it — but JSX instantiation isn't a static call edge,
 * so a render tree (App.render → StaticCanvas → renderStaticScene) breaks at the
 * JSX hop. Link parent → each capitalized JSX child it renders. File-oriented
 * (read each JSX file once). Precision gate: the child name must resolve to a
 * component/function/class node — TS generics like `Array<Foo>` resolve to a type
 * (or nothing) and are dropped.
 */
function reactJsxChildEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const PARENT_KINDS = new Set(['method', 'function', 'component']);
  for (const file of ctx.getAllFiles()) {
    const content = ctx.readFile(file);
    if (!content || (!content.includes('</') && !content.includes('/>'))) continue; // JSX-file gate
    const parents = ctx.getNodesInFile(file).filter((n) => PARENT_KINDS.has(n.kind));
    for (const parent of parents) {
      const src = sliceLines(content, parent.startLine, parent.endLine);
      if (!src || (!src.includes('</') && !src.includes('/>'))) continue;
      const names = new Set<string>();
      JSX_TAG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = JSX_TAG_RE.exec(src))) names.add(m[1]!);
      let added = 0;
      for (const name of names) {
        if (added >= MAX_JSX_CHILDREN) break;
        const child = ctx.getNodesByName(name).find(
          (n) => n.kind === 'component' || n.kind === 'function' || n.kind === 'class'
        );
        if (!child || child.id === parent.id) continue;
        const key = `${parent.id}>${child.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: parent.id, target: child.id, kind: 'calls', line: parent.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'jsx-render', via: name },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * Phase 6: Vue SFC templates. The `.vue` extractor only parses `<script>`, so
 * template usage is invisible — child components and event handlers used ONLY in
 * the template have no edge to them. PascalCase children (`<VPNav/>`) are already
 * caught by reactJsxChildEdges (which scans the SFC component node), so this adds
 * the two Vue-specific shapes:
 *   - kebab-case children: `<el-button>` → `ElButton` component (renders).
 *   - event bindings: `@click="onClick"` / `v-on:submit="save"` → handler method.
 * Scoped to the `<template>` block of `.vue` files; resolution gate (kebab→
 * component, handler→function/method) keeps precision; inline arrows / `$emit`
 * skipped.
 */
function vueTemplateEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const COMPONENT_KINDS = new Set(['component', 'function', 'class']);
  const HANDLER_KINDS = new Set(['method', 'function']);
  // A composable's returned member may be a fn (`function close(){}`) or an
  // arrow assigned to a const (`const close = () => {}`).
  const RETURN_KINDS = new Set(['method', 'function', 'variable', 'constant']);
  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.vue')) continue;
    const content = ctx.readFile(file);
    const tpl = content && content.match(/<template[^>]*>([\s\S]*)<\/template>/i)?.[1];
    if (!tpl) continue;
    const comp = ctx.getNodesInFile(file).find((n) => n.kind === 'component');
    if (!comp) continue;

    // Composable-destructure map: alias → { composable, key }. Lets us resolve a
    // template handler that isn't a local function but a destructured composable
    // return (`@click="closeSidebar"` ← `const { close: closeSidebar } = useSidebarControl()`).
    const script = content.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
    const destructured = new Map<string, { composable: string; key: string }>();
    VUE_DESTRUCTURE_RE.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = VUE_DESTRUCTURE_RE.exec(script))) {
      if (!/^use[A-Z]/.test(dm[2]!)) continue; // composables / hooks only
      for (const part of dm[1]!.split(',')) {
        const pm = part.trim().match(/^(\w+)\s*(?::\s*(\w+))?$/); // key | key: alias
        if (pm) destructured.set(pm[2] || pm[1]!, { composable: dm[2]!, key: pm[1]! });
      }
    }

    let added = 0;
    const addEdge = (target: Node | undefined, meta: Record<string, unknown>) => {
      if (added >= MAX_JSX_CHILDREN || !target || target.id === comp.id) return;
      const k = `${comp.id}>${target.id}>${meta.synthesizedBy}`;
      if (seen.has(k)) return;
      seen.add(k);
      edges.push({ source: comp.id, target: target.id, kind: 'calls', line: comp.startLine, provenance: 'heuristic', metadata: meta });
      added++;
    };
    // Prefer a target in THIS SFC (handlers live in the same file's script) —
    // avoids cross-file mis-match when a name repeats across a monorepo.
    const resolve = (name: string, kinds: Set<string>): Node | undefined => {
      const matches = ctx.getNodesByName(name).filter((n) => kinds.has(n.kind));
      return matches.find((n) => n.filePath === file) ?? matches[0];
    };

    let m: RegExpExecArray | null;
    VUE_KEBAB_RE.lastIndex = 0;
    while ((m = VUE_KEBAB_RE.exec(tpl))) addEdge(resolve(kebabToPascal(m[1]!), COMPONENT_KINDS), { synthesizedBy: 'jsx-render', via: m[1] });
    VUE_HANDLER_RE.lastIndex = 0;
    while ((m = VUE_HANDLER_RE.exec(tpl))) {
      const event = m[1]!;
      const expr = m[2]!.trim();
      if (expr.includes('=>') || expr.startsWith('$')) continue; // inline arrow / $emit
      const name = expr.match(/^([A-Za-z_]\w*)/)?.[1];
      if (!name) continue;
      const direct = resolve(name, HANDLER_KINDS);
      if (direct) { addEdge(direct, { synthesizedBy: 'vue-handler', event }); continue; }
      // Composable-destructure handler → resolve to the composable's returned fn.
      const d = destructured.get(name);
      if (!d) continue;
      const composable = resolve(d.composable, HANDLER_KINDS);
      // Resolve to the SPECIFIC returned member (e.g. `close`) defined in the
      // composable's file. No fallback to the composable itself — the component
      // already has a static `useX()` call edge, so that would just be redundant
      // and less precise.
      const keyFn = composable
        ? ctx.getNodesByName(d.key).find((n) => RETURN_KINDS.has(n.kind) && n.filePath === composable.filePath)
        : undefined;
      if (keyFn) addEdge(keyFn, { synthesizedBy: 'vue-handler', event, via: d.composable });
    }
  }
  return edges;
}

/**
 * Synthesize dispatcher→callback edges (field observers + EventEmitters +
 * React re-render + JSX children + Vue templates). Returns the count added.
 * Never throws into indexing — callers wrap in try/catch.
 */

// Bevy ECS dataflow: insert_resource(T) → resource_exists<T> signals.
// When fn A calls commands.insert_resource(X) and fn B is registered with
// .run_if(resource_exists::<X>()), synthesize a calls edge A→B so trace
// can follow the dataflow through the ECS command queue.
// Group 1 = turbofish type (commands.insert_resource::<Type>(...)),
// group 2 = constructor arg (base type, stops before ::Variant).
// Uses Unicode-aware [\p{L}\p{N}_] so CJK type names (e.g. 设置界面_确认保存_触发信号_资源) match.
const INSERT_RESOURCE_RE = /commands\s*\.\s*insert_resource\s*(?:::\s*<([\p{L}\p{N}_<>,: >]+)>\s*)?\(\s*([\p{L}\p{N}_]+)(?:::[\p{L}\p{N}_]+(?:\([^)]*\))?)*\s*[;{)]/gu;
const RESOURCE_EXISTS_RE = /run_if\s*\(\s*resource_exists\s*::\s*<\s*([\p{L}\p{N}_<>,: >]+)\s*>\s*\)/gu;

const NEXT_STATE_PENDING_RE = /NextState\s*::\s*Pending\s*\(\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*\)/gu;
const NEXT_STATE_SET_RE = /next_state\s*\.\s*set\s*\(\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*\)/gu;
const IN_STATE_RE = /in_state\s*\(\s*([\p{L}\p{N}_]+(?:\s*::\s*[\p{L}\p{N}_]+)*)\s*\)/gu;

function bevyEcsEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const resources = new Map<string, { inserters: Set<string>; checkers: Set<string> }>();
  const fnLines = new Map<string, number>();

  function ensure(r: string) {
    if (!resources.has(r)) resources.set(r, { inserters: new Set(), checkers: new Set() });
    return resources.get(r)!;
  }

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.rs')) continue;
    const content = ctx.readFile(file);
    if (!content) continue;

    const fileNodes = ctx.getNodesInFile(file);
    const fns = fileNodes.filter((n: { kind: string }) => n.kind === 'function' || n.kind === 'method');

    INSERT_RESOURCE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INSERT_RESOURCE_RE.exec(content))) {
      // Prefer turbofish type (group 1), fall back to constructor arg (group 2)
      const typeName = (m[1] || m[2])!.trim();
      const line = content.substring(0, m.index).split('\n').length;
      for (const fn of fns) {
        if (fn.startLine <= line && fn.endLine >= line) {
          ensure(typeName).inserters.add(fn.id);
          fnLines.set(fn.id, line);
          break;
        }
      }
    }

    RESOURCE_EXISTS_RE.lastIndex = 0;
    while ((m = RESOURCE_EXISTS_RE.exec(content))) {
      const typeName = m[1]!.trim();
      const line = content.substring(0, m.index).split('\n').length;
      for (const fn of fns) {
        if (fn.startLine <= line && fn.endLine >= line) {
          ensure(typeName).checkers.add(fn.id);
          fnLines.set(fn.id, line);
          break;
        }
      }
    }
  }

  for (const [, data] of resources) {
    if (data.inserters.size === 0 || data.checkers.size === 0) continue;
    for (const inserterId of data.inserters) {
      for (const checkerId of data.checkers) {
        edges.push({
          source: inserterId,
          target: checkerId,
          kind: 'calls',
          line: fnLines.get(inserterId),
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'bevy-ecs-resource' },
        });
      }
    }
  }

  return edges;
}

function bevyStateEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const states = new Map<string, { producers: Map<string, { line: number; full: string }>; consumers: Map<string, { line: number; full: string }> }>();

  function ensure(s: string) {
    if (!states.has(s)) states.set(s, { producers: new Map(), consumers: new Map() });
    return states.get(s)!;
  }

  // Normalize state name to last ::-segment so `GameState::Playing` and `Playing`
  // (after `use GameState::*`) map to the same key.
  function normalizeStateName(name: string): { full: string; variant: string } {
    const parts = name.split('::').filter(p => p.length > 0);
    const variant = parts[parts.length - 1] ?? name;
    const full = parts.length >= 2
      ? parts[parts.length - 2]! + '::' + variant
      : variant;
    return { full, variant };
  }

  // Strip Rust line (//) and block (/* */) comments to avoid false matches
  // in dead text. Same approach as other synthesizers that scan raw content.
  function stripRustComments(src: string): string {
    let result = '';
    let i = 0;
    while (i < src.length) {
      if (src[i] === '/' && src[i + 1] === '/') {
        // Line comment — skip to end of line
        const nl = src.indexOf('\n', i);
        if (nl < 0) break;
        result += '\n'.repeat(src.substring(i, nl).split('\n').length - 1) + '\n';
        i = nl + 1;
      } else if (src[i] === '/' && src[i + 1] === '*') {
        // Nested block comment — track /* */ depth
        let depth = 1;
        let j = i + 2;
        while (j < src.length - 1 && depth > 0) {
          if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; }
          else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; }
          else { result += src[j] === '\n' ? '\n' : ' '; j++; }
        }
        // Unclosed block comment: preserve rest as spaces (keep newlines for line numbers)
        if (depth > 0) {
          while (j < src.length) { result += src[j] === '\n' ? '\n' : ' '; j++; }
        }
        result += '  '; // closing */
        i = j;
      } else if ((src[i] === 'r' || src[i] === 'b') && i + 1 < src.length) {
        // Raw / byte string: r"...", r#"..."#, br"..."
        let j = i + 1;
        if (src[j] === 'r') j++;
        let hashes = 0;
        while (j < src.length && src[j] === '#') { hashes++; j++; }
        if (j < src.length && src[j] === '"') {
          j++;
          const close = '"' + '#'.repeat(hashes);
          const end = src.indexOf(close, j);
          if (end < 0) break; // unclosed raw string — stop
          for (let k = i; k < end + close.length; k++) {
            result += src[k] === '\n' ? '\n' : ' ';
          }
          i = end + close.length;
        } else {
          // Not a raw/byte string (e.g. `return`, `break`) — emit char and advance
          result += src[i]; i++;
        }
      } else if (src[i] === '"') {
        // Regular string literal — skip contents (preserve newlines)
        result += ' ';
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\' && i + 1 < src.length) { result += ' '; i += 2; continue; }
          if (src[i] === '\n') result += '\n'; else result += ' ';
          i++;
        }
        if (i < src.length) { result += ' '; i++; }
      } else {
        result += src[i];
        i++;
      }
    }
    return result;
  }

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.rs')) continue;
    const rawContent = ctx.readFile(file);
    if (!rawContent) continue;
    const content = stripRustComments(rawContent);

    const fileNodes = ctx.getNodesInFile(file);
    const fns = fileNodes.filter((n: { kind: string }) => n.kind === 'function' || n.kind === 'method');

    function findEnclosingFn(line: number): string | null {
      for (const fn of fns) {
        if (fn.startLine <= line && fn.endLine >= line) return fn.id;
      }
      return null;
    }

    // Producers: NextState::Pending(X) — typically in OnEnter or transition systems
    NEXT_STATE_PENDING_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NEXT_STATE_PENDING_RE.exec(content))) {
      const { full, variant } = normalizeStateName(m[1]!.trim());
      const line = content.substring(0, m.index).split('\n').length;
      const fnId = findEnclosingFn(line);
      if (fnId) {
        const entry = ensure(variant);
        if (!entry.producers.has(fnId)) entry.producers.set(fnId, { line, full });
      }
    }

    // Producers: next_state.set(X) — Bevy 0.15+ ResMut<NextState<X>>.set()
    NEXT_STATE_SET_RE.lastIndex = 0;
    while ((m = NEXT_STATE_SET_RE.exec(content))) {
      const { full, variant } = normalizeStateName(m[1]!.trim());
      const line = content.substring(0, m.index).split('\n').length;
      const fnId = findEnclosingFn(line);
      if (fnId) {
        const entry = ensure(variant);
        if (!entry.producers.has(fnId)) entry.producers.set(fnId, { line, full });
      }
    }

    // Consumers: in_state(X) — typically in OnEnter or condition systems
    IN_STATE_RE.lastIndex = 0;
    while ((m = IN_STATE_RE.exec(content))) {
      const { full, variant } = normalizeStateName(m[1]!.trim());
      const line = content.substring(0, m.index).split('\n').length;
      const fnId = findEnclosingFn(line);
      if (fnId) {
        const entry = ensure(variant);
        if (!entry.consumers.has(fnId)) entry.consumers.set(fnId, { line, full });
      }
    }
  }

  for (const [stateKey, data] of states) {
    if (data.producers.size === 0 || data.consumers.size === 0) continue;
    for (const [producerId, pInfo] of data.producers) {
      for (const [consumerId, cInfo] of data.consumers) {
        if (producerId === consumerId) continue;
        // Cross-enum guard: if both sides are qualified (EnumType::Variant) and the
        // enum type differs, skip — GameState::Playing ≠ UiState::Playing.
        if (pInfo.full !== stateKey && cInfo.full !== stateKey && pInfo.full !== cInfo.full) continue;
        edges.push({
          source: producerId,
          target: consumerId,
          kind: 'calls',
          line: pInfo.line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'bevy-ecs-state', stateName: stateKey },
        });
      }
    }
  }

  return edges;
}

export function synthesizeCallbackEdges(queries: QueryBuilder, ctx: ResolutionContext): number {
  const fieldEdges = fieldChannelEdges(queries, ctx);
  const emitterEdges = eventEmitterEdges(ctx);
  const renderEdges = reactRenderEdges(queries, ctx);
  const jsxEdges = reactJsxChildEdges(ctx);
  const vueEdges = vueTemplateEdges(ctx);
  const flutterEdges = flutterBuildEdges(queries, ctx);
  const cppEdges = cppOverrideEdges(queries);
  const ifaceEdges = interfaceOverrideEdges(queries);

  const merged: Edge[] = [];
  const seen = new Set<string>();
  const bevyEdges = bevyEcsEdges(ctx);
  const stateEdges = bevyStateEdges(ctx);
  for (const e of [...fieldEdges, ...emitterEdges, ...renderEdges, ...jsxEdges, ...vueEdges, ...flutterEdges, ...cppEdges, ...ifaceEdges, ...bevyEdges, ...stateEdges]) {
    const key = `${e.source}>${e.target}>${(e.metadata as Record<string, unknown>)?.synthesizedBy ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  if (merged.length > 0) queries.insertEdges(merged);
  return merged.length;
}
