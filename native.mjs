import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertLatticeProvider,
  assertSemiringProvider,
  assertScalarWfstProvider,
  normalizeLatticeProviderOptions,
  normalizeSemiringProviderOptions,
  normalizeScalarWfstProviderOptions,
} from "@vinary-tree/vinary-tree-interop";

const require = createRequire(import.meta.url);
const platform = `${process.platform}-${process.arch}`;
const prebuiltAddon = new URL(
  `./native/prebuilds/${platform}/vinary_tree_native.node`,
  import.meta.url,
);
const developmentAddon = new URL(
  "./native/build/Release/vinary_tree_native.node",
  import.meta.url,
);
const addon = existsSync(fileURLToPath(prebuiltAddon))
  ? prebuiltAddon
  : developmentAddon;
let ffi;
try {
  ffi = require(fileURLToPath(addon));
} catch (cause) {
  throw new Error(
    `@vinary-tree/javascript-runtime has no usable native addon for ${platform}; `
      + "install a supported prebuilt package or build the addon from source",
    { cause },
  );
}
const runtimeIdentity = Object.freeze({ implementation: "vinary-tree-node-napi-v1" });
const domains = new Map([["byte", 1], ["unicode", 2], ["u64", 3]]);
const algebraOperations = new Map([
  ["union", 1], ["intersection", 2], ["difference", 3], ["symmetric-difference", 4],
]);
const valueMerges = new Map([
  ["first", 1], ["last", 2], ["lattice-join", 3], ["lattice-meet", 4],
]);
const algorithms = new Map([
  ["standard", 0], ["transposition", 1], ["merge-and-split", 2], ["damerau-levenshtein", 3],
]);
const orders = new Map([["traversal", 0], ["distance-then-term", 1]]);
const duallityKinds = new Map([
  ["levenshtein", 0], ["universal-standard", 1], ["universal-transposition", 2],
  ["universal-merge-and-split", 3], ["generalized-standard", 4],
  ["generalized-transposition", 5], ["generalized-merge-and-split", 6],
  ["generalized-phonetic", 7], ["fzf", 8],
]);
const weightDomains = new Map([
  [1, "tropical-f64"], [2, "log-f64"], [3, "probability-f64"], [4, "arctic-f64"],
  [5, "signed-tropical-f64"], [6, "count-f64"], [7, "boolean-f64"],
]);
const unitDomains = new Map(Array.from(domains, ([name, value]) => [value, name]));
const weightDomainValues = new Map(Array.from(weightDomains, ([value, name]) => [name, value]));
const semiringProperties = new Map([
  ["hashable", 1n], ["idempotent-plus", 2n], ["k-closed", 4n],
  ["zero-sum-free", 8n], ["commutative-times", 16n],
  ["totally-ordered", 32n], ["nonnegative", 64n],
]);

function select(table, value, kind) {
  const selected = table.get(value);
  if (selected === undefined) throw new TypeError(`unknown ${kind}: ${value}`);
  return selected;
}

function cacheLimit(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > 0xffff_ffff) {
    throw new RangeError(`${name} must be an integer from 0 through 4294967295`);
  }
  return selected;
}

function requireScalarWfstProvider(provider) {
  assertScalarWfstProvider(provider);
  return provider;
}

function hostLattice(provider, options) {
  assertLatticeProvider(provider);
  const { domainId } = normalizeLatticeProviderOptions(options);
  return [provider, domainId];
}

function hostSemiring(provider, options) {
  assertSemiringProvider(provider);
  const normalized = normalizeSemiringProviderOptions(options);
  const propertyBits = normalized.properties.reduce(
    (bits, property) => bits | select(semiringProperties, property, "semiring property"), 0n,
  );
  return { provider, ...normalized, propertyBits };
}

function hostWfstOptions(options) {
  const { unitDomain, weightDomain, lazy, acyclic } = normalizeScalarWfstProviderOptions(options);
  let flags = 0;
  if (lazy) flags |= 4;
  if (acyclic) flags |= 8;
  return [
    select(domains, unitDomain, "unit domain"),
    select(weightDomainValues, weightDomain, "weight domain"),
    flags,
  ];
}

class DictionaryEntryCursor {
  #handle;
  #pending = [];
  #offset = 0;
  constructor(opened) {
    this.#handle = opened.handle;
    this.size = opened.size;
    this.identity = opened.identity === null ? null : Object.freeze(opened.identity);
  }
  [Symbol.iterator]() { return this; }
  next() {
    if (this.#offset >= this.#pending.length) {
      this.#pending = this.#fetch(256);
      this.#offset = 0;
    }
    if (this.#pending.length === 0) {
      this.close();
      return { done: true, value: undefined };
    }
    return { done: false, value: this.#pending[this.#offset++] };
  }
  nextBatch(maximum) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new RangeError("batch size must be a positive safe integer");
    }
    const result = [];
    while (result.length < maximum) {
      while (this.#offset < this.#pending.length && result.length < maximum) {
        result.push(this.#pending[this.#offset++]);
      }
      if (result.length === maximum || this.#handle === null) break;
      this.#pending = this.#fetch(maximum - result.length);
      this.#offset = 0;
      if (this.#pending.length === 0) {
        this.close();
        break;
      }
    }
    return result;
  }
  #fetch(maximum) {
    return this.#handle === null
      ? []
      : ffi.dictionaryEntryCursorNextBatch(this.#handle, maximum);
  }
  reduceBatches(reducer, initial, batchSize = 256) {
    let accumulator = initial;
    try {
      for (;;) {
        const batch = this.nextBatch(batchSize);
        if (batch.length === 0) return accumulator;
        accumulator = reducer(accumulator, batch);
      }
    } finally {
      this.close();
    }
  }
  return() {
    this.close();
    return { done: true, value: undefined };
  }
  close() {
    if (this.#handle !== null) {
      ffi.dictionaryEntryCursorClose(this.#handle);
      this.#handle = null;
      this.#pending = [];
      this.#offset = 0;
    }
  }
  [Symbol.dispose]() { this.close(); }
}

class Dictionary {
  #handle;
  #kind;
  constructor(handle, unitDomain, kind) {
    this.#handle = handle;
    this.#kind = kind;
    Object.defineProperties(this, {
      interfaceId: { value: "vt.dictionary.v1", enumerable: true },
      runtimeIdentity: { value: runtimeIdentity, enumerable: true },
      unitDomain: { value: unitDomain, enumerable: true },
      valueDomain: { value: "optional-u64", enumerable: true },
    });
  }
  get _handle() {
    if (this.#handle === null) throw new Error("dictionary is closed");
    return this.#handle;
  }
  get size() { return ffi.dictionaryLen(this._handle); }
  put(term, value = null) {
    if (term instanceof BigUint64Array) return ffi.dictionaryPutU64(this._handle, term, value);
    if (term instanceof Uint8Array) return ffi.dictionaryPutBytes(this._handle, term, value);
    return ffi.dictionaryPutText(this._handle, term, value);
  }
  putU64(term, value = null) { return ffi.dictionaryPutU64(this._handle, term, value); }
  set(term, value = null) { this.put(term, value); return this; }
  remove(term) {
    if (term instanceof BigUint64Array) return ffi.dictionaryRemoveU64(this._handle, term);
    if (term instanceof Uint8Array) return ffi.dictionaryRemoveBytes(this._handle, term);
    return ffi.dictionaryRemoveText(this._handle, term);
  }
  delete(term) { return this.remove(term); }
  removeU64(term) { return ffi.dictionaryRemoveU64(this._handle, term); }
  lookup(term) {
    if (term instanceof BigUint64Array) return ffi.dictionaryGetU64(this._handle, term);
    if (term instanceof Uint8Array) return ffi.dictionaryGetBytes(this._handle, term);
    return ffi.dictionaryGetText(this._handle, term);
  }
  lookupU64(term) { return ffi.dictionaryGetU64(this._handle, term); }
  get(term) { const result = this.lookup(term); return result.found ? result.value : undefined; }
  getU64(term) { const result = this.lookupU64(term); return result.found ? result.value : undefined; }
  has(term) { return this.lookup(term).found; }
  hasU64(term) { return this.lookupU64(term).found; }
  streamEntries() { return new DictionaryEntryCursor(ffi.dictionaryEntriesOpen(this._handle)); }
  algebra(right, operation, valueMerge = "last") {
    if (!(right instanceof Dictionary)) {
      throw new TypeError("dictionary algebra requires a dictionary from this runtime");
    }
    const handle = ffi.dictionaryAlgebra(
      this._handle,
      right._handle,
      select(algebraOperations, operation, "dictionary algebra operation"),
      select(valueMerges, valueMerge, "dictionary value-merge policy"),
    );
    return new Dictionary(handle, this.unitDomain, "dynamic-dawg");
  }
  union(right, valueMerge = "last") { return this.algebra(right, "union", valueMerge); }
  intersection(right, valueMerge = "lattice-meet") {
    return this.algebra(right, "intersection", valueMerge);
  }
  difference(right) { return this.algebra(right, "difference"); }
  symmetricDifference(right) { return this.algebra(right, "symmetric-difference"); }
  snapshotEntries() {
    const result = [];
    const cursor = this.streamEntries();
    try {
      for (const [key, value] of cursor) result.push(Object.freeze([key, value]));
    } finally {
      cursor.close();
    }
    return Object.freeze(result);
  }
  entries() { return this.snapshotEntries()[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  *keys() { for (const [key] of this) yield key; }
  *values() { for (const [, value] of this) yield value; }
  forEach(callback, thisArg = undefined) {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
  toMap() {
    if (this.unitDomain !== "unicode") {
      throw new TypeError("toMap is defined only for value-equal JavaScript string keys");
    }
    return new Map(this);
  }
  clear() { return ffi.dictionaryClear(this._handle); }
  compact() { return ffi.dictionaryCompact(this._handle); }
  checkpoint() { return ffi.dictionaryCheckpoint(this._handle); }
  containsSubstring(term) { return ffi.containsSubstring(this._handle, term); }
  substringFrequency(term) { return ffi.substringFrequency(this._handle, term); }
  close() {
    if (this.#handle !== null) {
      ffi.dictionaryClose(this.#handle);
      this.#handle = null;
    }
  }
  [Symbol.dispose]() { this.close(); }
  get kind() { return this.#kind; }
}

class QueryCursor {
  #handle;
  #pending = [];
  #offset = 0;
  constructor(handle) { this.#handle = handle; }
  [Symbol.iterator]() { return this; }
  next() {
    if (this.#offset >= this.#pending.length) {
      this.#pending = this.#fetch(256);
      this.#offset = 0;
    }
    if (this.#pending.length === 0) {
      this.close();
      return { done: true, value: undefined };
    }
    return { done: false, value: this.#pending[this.#offset++] };
  }
  nextBatch(maximum) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new RangeError("batch size must be positive");
    const result = [];
    while (result.length < maximum) {
      while (this.#offset < this.#pending.length && result.length < maximum) {
        result.push(this.#pending[this.#offset++]);
      }
      if (result.length === maximum || this.#handle === null) break;
      this.#pending = this.#fetch(maximum - result.length);
      this.#offset = 0;
      if (this.#pending.length === 0) {
        this.close();
        break;
      }
    }
    return result;
  }
  #fetch(maximum) {
    return this.#handle === null ? [] : ffi.cursorNextBatch(this.#handle, maximum);
  }
  reduceBatches(reducer, initial, batchSize = 256) {
    let accumulator = initial;
    try {
      for (;;) {
        const batch = this.nextBatch(batchSize);
        if (batch.length === 0) return accumulator;
        accumulator = reducer(accumulator, batch);
      }
    } finally {
      this.close();
    }
  }
  close() {
    if (this.#handle !== null) {
      ffi.cursorClose(this.#handle);
      this.#handle = null;
      this.#pending = [];
      this.#offset = 0;
    }
  }
  return() { this.close(); return { done: true, value: undefined }; }
  [Symbol.dispose]() { this.close(); }
}

class PhoneticPattern {
  #handle;
  constructor(handle) { this.#handle = handle; }
  get _handle() {
    if (this.#handle === null) throw new Error("phonetic pattern is closed");
    return this.#handle;
  }
  get size() { return ffi.patternSize(this._handle); }
  matches(input) { return ffi.patternMatches(this._handle, input); }
  close() {
    if (this.#handle !== null) {
      ffi.patternClose(this.#handle);
      this.#handle = null;
    }
  }
  [Symbol.dispose]() { this.close(); }
}

class PhoneticRuleSet {
  #handle;
  constructor(handle) { this.#handle = handle; }
  get size() {
    if (this.#handle === null) throw new Error("phonetic rules are closed");
    return ffi.rulesLen(this.#handle);
  }
  apply(input) {
    if (this.#handle === null) throw new Error("phonetic rules are closed");
    return ffi.rulesApply(this.#handle, input);
  }
  close() {
    if (this.#handle !== null) {
      ffi.rulesClose(this.#handle);
      this.#handle = null;
    }
  }
}

class Transducer {
  #handle;
  constructor(dictionary, algorithm) {
    if (dictionary?.runtimeIdentity !== runtimeIdentity || dictionary.interfaceId !== "vt.dictionary.v1") {
      throw new TypeError("dictionary belongs to a different Vinary Tree runtime");
    }
    this.#handle = ffi.transducerNew(dictionary._handle, select(algorithms, algorithm, "algorithm"));
  }
  get _handle() {
    if (this.#handle === null) throw new Error("transducer is closed");
    return this.#handle;
  }
  query(input, maximumDistance, order = "traversal") {
    if (input instanceof PhoneticPattern) {
      return new QueryCursor(ffi.queryPattern(this.#handle, input._handle, maximumDistance));
    }
    const selectedOrder = select(orders, order, "query order");
    if (typeof input === "string") {
      return new QueryCursor(ffi.queryText(this.#handle, input, maximumDistance, selectedOrder));
    }
    if (input instanceof BigUint64Array) {
      return new QueryCursor(ffi.queryU64(this.#handle, input, maximumDistance, selectedOrder));
    }
    if (input instanceof Uint8Array) {
      return new QueryCursor(ffi.queryBytes(this.#handle, input, maximumDistance, selectedOrder));
    }
    throw new TypeError("query requires text, Uint8Array, BigUint64Array, or a phonetic pattern");
  }
  close() {
    if (this.#handle !== null) {
      ffi.transducerClose(this.#handle);
      this.#handle = null;
    }
  }
  [Symbol.dispose]() { this.close(); }
}

class QueryCache {
  #handle;
  constructor(transducer, options = {}) {
    if (!(transducer instanceof Transducer)) {
      throw new TypeError("query cache requires a transducer from this runtime");
    }
    if (options === null || typeof options !== "object") {
      throw new TypeError("query cache options must be an object");
    }
    const maximumEntries = cacheLimit(options.maximumEntries, 1024, "maximumEntries");
    const maximumWeight = cacheLimit(options.maximumWeight, 64 * 1024 * 1024, "maximumWeight");
    this.#handle = ffi.queryCacheNew(transducer._handle, maximumEntries, maximumWeight);
  }
  get _handle() {
    if (this.#handle === null) throw new Error("query cache is closed");
    return this.#handle;
  }
  get stats() { return ffi.queryCacheStats(this._handle); }
  query(input, maximumDistance, order = "traversal") {
    const selectedOrder = select(orders, order, "query order");
    if (typeof input === "string") {
      return new QueryCursor(ffi.queryCacheText(this._handle, input, maximumDistance, selectedOrder));
    }
    if (input instanceof BigUint64Array) {
      return new QueryCursor(ffi.queryCacheU64(this._handle, input, maximumDistance, selectedOrder));
    }
    if (input instanceof Uint8Array) {
      return new QueryCursor(ffi.queryCacheBytes(this._handle, input, maximumDistance, selectedOrder));
    }
    throw new TypeError("cached query requires text, Uint8Array, or BigUint64Array");
  }
  clear() { ffi.queryCacheClear(this._handle); return this; }
  resetStats() { ffi.queryCacheResetStats(this._handle); return this; }
  close() {
    if (this.#handle !== null) {
      ffi.queryCacheClose(this.#handle);
      this.#handle = null;
    }
  }
  [Symbol.dispose]() { this.close(); }
}

class Wfst {
  #handle;
  constructor(handle) {
    this.#handle = handle;
    Object.defineProperties(this, {
      interfaceId: { value: "vt.scalar-wfst.1", enumerable: true },
      runtimeIdentity: { value: runtimeIdentity, enumerable: true },
    });
  }
  get _handle() {
    if (this.#handle === null) throw new Error("WFST is closed");
    return this.#handle;
  }
  get weightDomain() {
    const value = ffi.wfstWeightDomain(this._handle);
    const name = weightDomains.get(value);
    if (name === undefined) throw new Error(`unknown WFST weight domain ${value}`);
    return name;
  }
  get unitDomain() {
    const value = ffi.wfstUnitDomain(this._handle);
    const name = unitDomains.get(value);
    if (name === undefined) throw new Error(`unknown WFST unit domain ${value}`);
    return name;
  }
  start() { return ffi.wfstStart(this._handle); }
  state(state) { return ffi.wfstState(this._handle, state); }
  close() {
    if (this.#handle !== null) {
      ffi.wfstClose(this.#handle);
      this.#handle = null;
    }
  }
  [Symbol.dispose]() { this.close(); }
}

class Lattice {
  #handle;
  constructor(handle, domainId) {
    this.#handle = handle;
    Object.defineProperties(this, {
      interfaceId: { value: "vt.lattice.val.1", enumerable: true },
      runtimeIdentity: { value: runtimeIdentity, enumerable: true },
      domainId: { value: domainId, enumerable: true },
    });
  }
  get _handle() {
    if (this.#handle === null) throw new Error("lattice value is closed");
    return this.#handle;
  }
  #operand(other) {
    if (other?.runtimeIdentity !== runtimeIdentity ||
        other.interfaceId !== "vt.lattice.val.1" ||
        other.domainId !== this.domainId) {
      throw new TypeError("lattice operand belongs to a different runtime or domain");
    }
    return other._handle;
  }
  join(other) { return new Lattice(ffi.latticeJoin(this._handle, this.#operand(other)), this.domainId); }
  meet(other) { return new Lattice(ffi.latticeMeet(this._handle, this.#operand(other)), this.domainId); }
  equal(other) { return ffi.latticeEqual(this._handle, this.#operand(other)); }
  stableBytes() { return ffi.latticeStableBytes(this._handle); }
  diagnostic() { return ffi.latticeDiagnostic(this._handle); }
  joinMany(others) {
    if (!Array.isArray(others)) throw new TypeError("lattice operands must be an array");
    return new Lattice(
      ffi.latticeJoinMany(this._handle, others.map((other) => this.#operand(other))),
      this.domainId,
    );
  }
  meetMany(others) {
    if (!Array.isArray(others)) throw new TypeError("lattice operands must be an array");
    return new Lattice(
      ffi.latticeMeetMany(this._handle, others.map((other) => this.#operand(other))),
      this.domainId,
    );
  }
  close() {
    if (this.#handle !== null) {
      ffi.latticeClose(this.#handle);
      this.#handle = null;
    }
  }
  [Symbol.dispose]() { this.close(); }
}

class SemiringWeight {
  #handle;
  #semiring;
  constructor(handle, semiring) {
    this.#handle = handle;
    this.#semiring = semiring;
    Object.defineProperties(this, {
      interfaceId: { value: "vt.semiring.val1", enumerable: true },
      runtimeIdentity: { value: runtimeIdentity, enumerable: true },
      domainId: { value: semiring.domainId, enumerable: true },
    });
  }
  get _handle() {
    if (this.#handle === null) throw new Error("semiring weight is closed");
    return this.#handle;
  }
  get _semiring() { return this.#semiring; }
  clone() { return new SemiringWeight(ffi.semiringWeightClone(this._handle), this.#semiring); }
  stableBytes() { return this.#semiring.stableBytes(this); }
  diagnostic() { return this.#semiring.diagnostic(this); }
  close() {
    if (this.#handle !== null) {
      ffi.semiringWeightClose(this.#handle);
      this.#handle = null;
    }
  }
  [Symbol.dispose]() { this.close(); }
}

class Semiring {
  #handle;
  constructor(handle, options) {
    this.#handle = handle;
    Object.defineProperties(this, {
      interfaceId: { value: "vt.semiring.ctx1", enumerable: true },
      runtimeIdentity: { value: runtimeIdentity, enumerable: true },
      domainId: { value: options.domainId, enumerable: true },
      properties: { value: options.properties, enumerable: true },
    });
  }
  get _handle() {
    if (this.#handle === null) throw new Error("semiring context is closed");
    return this.#handle;
  }
  #operand(value) {
    if (value?.runtimeIdentity !== runtimeIdentity ||
        value.interfaceId !== "vt.semiring.val1" || value._semiring !== this) {
      throw new TypeError("semiring weight belongs to a different operation context");
    }
    return value._handle;
  }
  #weight(handle) { return new SemiringWeight(handle, this); }
  zero() { return this.#weight(ffi.semiringZero(this._handle)); }
  one() { return this.#weight(ffi.semiringOne(this._handle)); }
  plus(left, right) {
    return this.#weight(ffi.semiringPlus(this._handle, this.#operand(left), this.#operand(right)));
  }
  times(left, right) {
    return this.#weight(ffi.semiringTimes(this._handle, this.#operand(left), this.#operand(right)));
  }
  equal(left, right) {
    return ffi.semiringEqual(this._handle, this.#operand(left), this.#operand(right));
  }
  approximatelyEqual(left, right, epsilon) {
    return ffi.semiringApproximatelyEqual(
      this._handle, this.#operand(left), this.#operand(right), epsilon,
    );
  }
  naturalOrder(left, right) {
    return ffi.semiringNaturalOrder(this._handle, this.#operand(left), this.#operand(right));
  }
  stableBytes(value) { return ffi.semiringStableBytes(this._handle, this.#operand(value)); }
  diagnostic(value = null) {
    return ffi.semiringDiagnostic(
      this._handle, value === null ? null : this.#operand(value),
    );
  }
  plusMany(values) {
    if (!Array.isArray(values)) throw new TypeError("semiring operands must be an array");
    return this.#weight(ffi.semiringPlusMany(this._handle, values.map((v) => this.#operand(v))));
  }
  timesMany(values) {
    if (!Array.isArray(values)) throw new TypeError("semiring operands must be an array");
    return this.#weight(ffi.semiringTimesMany(this._handle, values.map((v) => this.#operand(v))));
  }
  divide(dividend, divisor) {
    const result = ffi.semiringDivide(
      this._handle, this.#operand(dividend), this.#operand(divisor),
    );
    return result === null ? null : this.#weight(result);
  }
  leftDivide(value, divisor) {
    const result = ffi.semiringLeftDivide(
      this._handle, this.#operand(value), this.#operand(divisor),
    );
    return result === null ? null : this.#weight(result);
  }
  star(value) {
    const result = ffi.semiringStar(this._handle, this.#operand(value));
    return result === null ? null : this.#weight(result);
  }
  numericalValue(value) { return ffi.semiringNumericalValue(this._handle, this.#operand(value)); }
  quantize(value, epsilon) {
    return ffi.semiringQuantize(this._handle, this.#operand(value), epsilon);
  }
  toProbability(value) {
    return ffi.semiringToProbability(this._handle, this.#operand(value));
  }
  closureBound() { return ffi.semiringClosureBound(this._handle); }
  validateLaws(values, epsilon = 0) {
    if (!Array.isArray(values)) throw new TypeError("semiring law samples must be an array");
    ffi.semiringValidateLaws(this._handle, values.map((v) => this.#operand(v)), epsilon);
  }
  close() {
    if (this.#handle !== null) {
      ffi.semiringClose(this.#handle);
      this.#handle = null;
    }
  }
  [Symbol.dispose]() { this.close(); }
}

class WfstBuilder {
  #handle = ffi.wfstBuilderNew();
  get _handle() {
    if (this.#handle === null) throw new Error("WFST builder is closed");
    return this.#handle;
  }
  addState() { return ffi.wfstBuilderAddState(this._handle); }
  setStart(state) { ffi.wfstBuilderSetStart(this._handle, state); }
  setFinal(state, weight = 0) { ffi.wfstBuilderSetFinal(this._handle, state, weight); }
  addArc(from, input, output, to, weight = 0) {
    const label = (value) => {
      if (value === null || value === undefined) return [0n, 0];
      if (typeof value !== "string" || [...value].length !== 1) {
        throw new TypeError("arc label must contain one Unicode scalar or be null");
      }
      return [BigInt(value.codePointAt(0)), 1];
    };
    const [inputLabel, hasInput] = label(input);
    const [outputLabel, hasOutput] = label(output);
    ffi.wfstBuilderAddArc(
      this._handle, from, inputLabel, hasInput, outputLabel, hasOutput, to, weight,
    );
  }
  build() { return new Wfst(ffi.wfstBuilderBuild(this._handle)); }
  close() {
    if (this.#handle !== null) {
      ffi.wfstBuilderClose(this.#handle);
      this.#handle = null;
    }
  }
  [Symbol.dispose]() { this.close(); }
}

const libdictenstein = Object.freeze({
  runtimeIdentity,
  dynamicDawg(unitDomain = "unicode") {
    return new Dictionary(ffi.dynamicDawgNew(select(domains, unitDomain, "unit domain")), unitDomain, "dynamic-dawg");
  },
  doubleArrayTrie(entries, unitDomain = "unicode") {
    return new Dictionary(ffi.doubleArrayTrieNew(select(domains, unitDomain, "unit domain"), entries), unitDomain, "double-array-trie");
  },
  scdawg(unitDomain = "unicode") {
    return new Dictionary(ffi.scdawgNew(select(domains, unitDomain, "unit domain")), unitDomain, "scdawg");
  },
  createPersistentARTrie(path, unitDomain = "unicode") {
    return new Dictionary(ffi.persistentARTrieCreate(select(domains, unitDomain, "unit domain"), path), unitDomain, "persistent-artrie");
  },
  openPersistentARTrie(path, unitDomain = "unicode") {
    return new Dictionary(ffi.persistentARTrieOpen(select(domains, unitDomain, "unit domain"), path), unitDomain, "persistent-artrie");
  },
});

const liblevenshtein = Object.freeze({
  runtimeIdentity,
  transducer(dictionary, algorithm = "standard") { return new Transducer(dictionary, algorithm); },
  queryCache(transducer, options) { return new QueryCache(transducer, options); },
  phoneticPattern(source) { return new PhoneticPattern(ffi.patternCompileRegex(source)); },
  llrePattern(source) { return new PhoneticPattern(ffi.patternCompileLlre(source)); },
  phoneticRules(source) { return new PhoneticRuleSet(ffi.rulesCompile(source)); },
  levenshteinDistance: ffi.levenshteinDistance,
  levenshteinDistanceThreshold: ffi.levenshteinDistanceThreshold,
  damerauDistance: ffi.damerauDistance,
  damerauDistanceThreshold: ffi.damerauDistanceThreshold,
  trueDamerauDistance: ffi.trueDamerauDistance,
  trueDamerauDistanceThreshold: ffi.trueDamerauDistanceThreshold,
});

const llingLlang = Object.freeze({
  runtimeIdentity,
  vectorWfst() { return new WfstBuilder(); },
  lattice(provider, options) {
    const [value, domainId] = hostLattice(provider, options);
    return new Lattice(ffi.hostLatticeNew(value, domainId), domainId);
  },
  semiring(provider, options) {
    const normalized = hostSemiring(provider, options);
    const closureKnown = normalized.closureBound !== null;
    const closureBound = normalized.closureBound ?? 0n;
    return new Semiring(
      ffi.hostSemiringNew(
        normalized.provider, normalized.domainId, normalized.propertyBits,
        closureKnown, closureBound,
      ),
      normalized,
    );
  },
  validateLatticeLaws(values) {
    if (!Array.isArray(values)) throw new TypeError("lattice law samples must be an array");
    const handles = values.map((value) => {
      if (value?.runtimeIdentity !== runtimeIdentity ||
          value.interfaceId !== "vt.lattice.val.1") {
        throw new TypeError("lattice sample belongs to a different runtime");
      }
      return value._handle;
    });
    ffi.latticeValidateLaws(handles);
  },
  scalarWfst(provider, options = {}) {
    const [unitDomain, weightDomain, flags] = hostWfstOptions(options);
    return new Wfst(ffi.hostWfstNew(
      requireScalarWfstProvider(provider), unitDomain, weightDomain, flags,
    ));
  },
  compose(first, second) {
    if (first?.runtimeIdentity !== runtimeIdentity || second?.runtimeIdentity !== runtimeIdentity) {
      throw new TypeError("WFST belongs to a different Vinary Tree runtime");
    }
    return new Wfst(ffi.wfstCompose(first._handle, second._handle));
  },
});

const duallity = Object.freeze({
  runtimeIdentity,
  wfst(dictionary, query, maximumDistance, algorithm = "standard", kind = "levenshtein") {
    if (dictionary?.runtimeIdentity !== runtimeIdentity || dictionary.interfaceId !== "vt.dictionary.v1") {
      throw new TypeError("dictionary belongs to a different Vinary Tree runtime");
    }
    return new Wfst(ffi.duallityWfstNew(
      dictionary._handle,
      query,
      maximumDistance,
      select(algorithms, algorithm, "algorithm"),
      select(duallityKinds, kind, "duallity WFST kind"),
    ));
  },
});

const runtime = Object.freeze({ runtimeIdentity, libdictenstein, liblevenshtein, llingLlang, duallity });
export { runtimeIdentity, libdictenstein, liblevenshtein, llingLlang, duallity };
export default runtime;
