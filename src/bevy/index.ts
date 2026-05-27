/**
 * Bevy ECS fork extensions — registration entry point.
 *
 * Importing this module triggers side-effect registration of all Bevy
 * synthesizers with the callback-synthesizer registry. The host only
 * needs `import './bevy'` — no explicit function calls.
 *
 * This file is the single place where Bevy synthesizers are wired up.
 * When merging upstream changes to callback-synthesizer.ts, only the
 * registry infrastructure (~10 lines) needs to be preserved.
 */
import { registerSynthesizer } from '../resolution/callback-synthesizer';
import { bevyEcsEdges } from '../resolution/synthesizers/bevy-ecs';
import { bevyStateEdges } from '../resolution/synthesizers/bevy-state';
import { bevyDslEdges } from '../resolution/synthesizers/bevy-dsl';

registerSynthesizer((_queries, ctx) => bevyEcsEdges(ctx));
registerSynthesizer((_queries, ctx) => bevyStateEdges(ctx));
registerSynthesizer((queries, ctx) => bevyDslEdges(queries, ctx));
