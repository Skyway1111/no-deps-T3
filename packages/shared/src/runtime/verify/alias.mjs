// `node --import ./alias.mjs x.ts` resolves effect/* via ../subpathMap.json; unmapped subpaths become inert stubs.
// `RUNTIME=effect` instead resolves them to the installed effect (from EFFECT_FROM, default packages/contracts).
// Stub export names come from that installed effect too, so it must be installed either way.
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
