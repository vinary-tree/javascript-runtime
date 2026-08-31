import type { RuntimeIdentity, UnitDomain } from "@vinary-tree/vinary-tree-interop";
import type {
  Dictionary, Transducer, QueryCache, QueryCacheOptions, Algorithm,
  LlingLlangNamespace, DuallityNamespace,
} from "./index.js";

export interface PersistentDictionary extends Dictionary { checkpoint(): void; }
export interface WasiRuntime {
  readonly runtimeIdentity: RuntimeIdentity;
  readonly libdictenstein: {
    readonly runtimeIdentity: RuntimeIdentity;
    dynamicDawg(unitDomain?: UnitDomain): Dictionary;
    createPersistentARTrie(path: string, unitDomain?: UnitDomain): PersistentDictionary;
    openPersistentARTrie(path: string, unitDomain?: UnitDomain): PersistentDictionary;
  };
  readonly liblevenshtein: {
    readonly runtimeIdentity: RuntimeIdentity;
    transducer(dictionary: Dictionary, algorithm?: Algorithm): Transducer;
    queryCache(transducer: Transducer, options?: QueryCacheOptions): QueryCache;
  };
  readonly llingLlang: LlingLlangNamespace;
  readonly duallity: DuallityNamespace;
}
export interface WasiRuntimeOptions {
  preopens?: Record<string, string>;
  wasm?: URL | WebAssembly.Module;
}
export function createWasiRuntime(options?: WasiRuntimeOptions): Promise<WasiRuntime>;
export const runtimeIdentity: RuntimeIdentity;
export const libdictenstein: WasiRuntime["libdictenstein"];
export const liblevenshtein: WasiRuntime["liblevenshtein"];
export const llingLlang: WasiRuntime["llingLlang"];
export const duallity: WasiRuntime["duallity"];
declare const runtime: WasiRuntime;
export default runtime;
