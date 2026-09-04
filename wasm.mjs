import initialize, * as raw from "./generated/wasm/vinary_tree.js";
import { createRuntime } from "./runtime-factory.mjs";

await initialize();

const runtime = createRuntime(raw);
export const runtimeIdentity = runtime.runtimeIdentity;
export const libdictenstein = runtime.libdictenstein;
export const liblevenshtein = runtime.liblevenshtein;
export const llingLlang = runtime.llingLlang;
export const duallity = runtime.duallity;
export default runtime;
