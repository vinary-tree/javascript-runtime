import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";
import {
  assertScalarWfstProvider,
  normalizeScalarWfstProviderOptions,
} from "@vinary-tree/vinary-tree-interop";

const FAILURE = 0xffff_ffff;
const RECORD_SIZE = 32;
const ENTRY_RECORD_HEADER_SIZE = 24;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const DOMAINS = new Map([["byte", 0], ["unicode", 1], ["u64", 2]]);
const ALGEBRA_OPERATIONS = new Map([
  ["union", 1], ["intersection", 2], ["difference", 3], ["symmetric-difference", 4],
]);
const VALUE_MERGES = new Map([
  ["first", 1], ["last", 2], ["lattice-join", 3], ["lattice-meet", 4],
]);
const ALGORITHMS = new Map([
  ["standard", 0],
  ["transposition", 1],
  ["merge-and-split", 2],
  ["damerau-levenshtein", 3],
]);
const ORDERS = new Map([["traversal", 0], ["distance-then-term", 1]]);
const DUALLITY_KINDS = new Map([
  ["levenshtein", 0], ["universal-standard", 1], ["universal-transposition", 2],
  ["universal-merge-and-split", 3], ["generalized-standard", 4],
  ["generalized-transposition", 5], ["generalized-merge-and-split", 6],
  ["generalized-phonetic", 7], ["fzf", 8],
]);
const WEIGHT_DOMAINS = new Map([
  [1, "tropical-f64"], [2, "log-f64"], [3, "probability-f64"], [4, "arctic-f64"],
  [5, "signed-tropical-f64"], [6, "count-f64"], [7, "boolean-f64"],
]);
const WFST_UNIT_DOMAINS = new Map([["byte", 1], ["unicode", 2], ["u64", 3]]);
const WFST_UNIT_DOMAIN_NAMES = new Map(Array.from(WFST_UNIT_DOMAINS, ([name, value]) => [value, name]));
const WEIGHT_DOMAIN_VALUES = new Map(Array.from(WEIGHT_DOMAINS, ([value, name]) => [name, value]));
const HOST_OK = 0;
const HOST_INVALID_ARGUMENT = 2;
const HOST_CLOSED = 6;
const HOST_LIMIT_EXCEEDED = 7;
const HOST_PROVIDER_ERROR = 8;
const HOST_INDEX_MASK = 0xffff;
const HOST_MAX_COMPONENT = 0xfffe;

class GenerationalProviderTable {
  #slots = [];
  #free = [];

  insert(provider, unitDomain) {
    let index;
    if (this.#free.length > 0) {
      index = this.#free.pop();
    } else {
      if (this.#slots.length >= HOST_MAX_COMPONENT) {
        throw new RangeError("WASI host provider table is full");
      }
      index = this.#slots.length;
      this.#slots.push({ generation: 1, provider: null, unitDomain: 0, active: false });
    }
    const slot = this.#slots[index];
    slot.provider = provider;
    slot.unitDomain = unitDomain;
    slot.active = false;
    return ((slot.generation << 16) | (index + 1)) >>> 0;
  }

  release(handle) {
    const selected = this.#lookup(handle);
    if (selected === null) return;
    const { index, slot } = selected;
    slot.provider = null;
    slot.unitDomain = 0;
    slot.active = false;
    slot.generation = slot.generation === HOST_MAX_COMPONENT ? 1 : slot.generation + 1;
    this.#free.push(index);
  }

  invoke(handle, operation) {
    const selected = this.#lookup(handle);
    if (selected === null) return HOST_CLOSED;
    const { slot } = selected;
    if (slot.active) return HOST_PROVIDER_ERROR;
    slot.active = true;
    try {
      operation(slot.provider, slot.unitDomain);
      return HOST_OK;
    } catch {
      return HOST_PROVIDER_ERROR;
    } finally {
      slot.active = false;
    }
  }

  #lookup(handle) {
    const unsigned = handle >>> 0;
    const low = unsigned & HOST_INDEX_MASK;
    const generation = unsigned >>> 16;
    if (low === 0 || low > HOST_MAX_COMPONENT || generation === 0 || generation > HOST_MAX_COMPONENT) {
      return null;
    }
    const index = low - 1;
    const slot = this.#slots[index];
    if (slot === undefined || slot.provider === null || slot.generation !== generation) return null;
    return { index, slot };
  }
}

function requireScalarWfstProvider(provider) {
  assertScalarWfstProvider(provider);
  return provider;
}

function hostWfstOptions(options) {
  const { unitDomain, weightDomain, lazy, acyclic } = normalizeScalarWfstProviderOptions(options);
  const unitDomainValue = WFST_UNIT_DOMAINS.get(unitDomain);
  const weightDomainValue = WEIGHT_DOMAIN_VALUES.get(weightDomain);
  let flags = 2n;
  if (lazy) flags |= 4n;
  if (acyclic) flags |= 8n;
  return {
    unitDomain: unitDomainValue,
    weightDomain: weightDomainValue,
    flags,
    unitDomainName: unitDomain,
    weightDomainName: weightDomain,
  };
}

function exactU64(value, name) {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${name} must be an unsigned 64-bit bigint`);
  }
  return value;
}

function exactNumber(value, name) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${name} must be a non-NaN number`);
  }
  return value;
}

function providerLabel(value, unitDomain) {
  if (value === null) return [0n, 0];
  if (unitDomain === 1) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new RangeError("byte WFST labels must be integers from 0 through 255 or null");
    }
    return [BigInt(value), 1];
  }
  if (unitDomain === 2) {
    if (typeof value !== "string" || [...value].length !== 1) {
      throw new TypeError("Unicode WFST labels must contain one scalar or be null");
    }
    return [BigInt(value.codePointAt(0)), 1];
  }
  return [exactU64(value, "u64 WFST label"), 1];
}

function providerArc(value, unitDomain) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("WFST arc must be an object");
  }
  const [input, hasInput] = providerLabel(value.input, unitDomain);
  const [output, hasOutput] = providerLabel(value.output, unitDomain);
  return {
    input,
    output,
    target: exactU64(value.target, "WFST arc target"),
    weight: exactNumber(value.weight, "WFST arc weight"),
    hasInput,
    hasOutput,
  };
}

/** Instantiate an isolated WASI runtime with explicit guest-to-host preopens. */
export async function createWasiRuntime({
  preopens = { "/workspace": process.cwd() },
  wasm = new URL("./generated/wasi/vinary_tree.wasm", import.meta.url),
} = {}) {
  const wasi = new WASI({ version: "preview1", args: [], env: {}, preopens });
  const source = wasm instanceof WebAssembly.Module ? wasm : await readFile(wasm);
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const providers = new GenerationalProviderTable();
  let ffi;
  const memoryView = () => new DataView(ffi.memory.buffer);
  const host = {
    host_provider_release(handle) {
      providers.release(handle);
    },
    host_provider_start(handle, outputPointer) {
      return providers.invoke(handle, (provider) => {
        const state = exactU64(provider.startState(), "WFST start state");
        memoryView().setBigUint64(outputPointer, state, true);
      });
    },
    host_provider_num_states(handle, countPointer, knownPointer) {
      return providers.invoke(handle, (provider) => {
        const count = provider.stateCount();
        const memory = memoryView();
        if (count === null) {
          memory.setUint32(countPointer, 0, true);
          memory.setUint8(knownPointer, 0);
          return;
        }
        const exact = exactU64(count, "WFST state count");
        if (exact > 0xffff_ffffn) throw new RangeError("WASI WFST state count exceeds u32");
        memory.setUint32(countPointer, Number(exact), true);
        memory.setUint8(knownPointer, 1);
      });
    },
    host_provider_state_info(handle, state, validPointer, finalPointer, weightPointer) {
      return providers.invoke(handle, (provider) => {
        const value = provider.stateInfo(state);
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new TypeError("WFST stateInfo must return an object");
        }
        if (typeof value.valid !== "boolean" || typeof value.final !== "boolean") {
          throw new TypeError("WFST state valid and final metadata must be boolean");
        }
        if (!value.valid && value.final) {
          throw new TypeError("an invalid WFST state cannot be final");
        }
        const finalWeight = exactNumber(value.finalWeight, "WFST final weight");
        const memory = memoryView();
        memory.setUint8(validPointer, Number(value.valid));
        memory.setUint8(finalPointer, Number(value.final));
        memory.setFloat64(weightPointer, finalWeight, true);
      });
    },
    host_provider_state_arcs(
      handle,
      state,
      start,
      arcsPointer,
      capacity,
      writtenPointer,
      totalPointer,
    ) {
      return providers.invoke(handle, (provider, unitDomain) => {
        let values;
        let total;
        if (provider.stateArcsPage === undefined) {
          const all = provider.stateArcs(state);
          if (!Array.isArray(all)) throw new TypeError("WFST stateArcs must return an array");
          total = all.length;
          values = all.slice(start, start + capacity);
        } else {
          const page = provider.stateArcsPage(state, BigInt(start), capacity);
          if (page === null || typeof page !== "object" || Array.isArray(page)) {
            throw new TypeError("WFST stateArcsPage must return an object");
          }
          if (!Array.isArray(page.arcs)) throw new TypeError("WFST arc page must contain an array");
          const exactTotal = exactU64(page.total, "WFST arc-page total");
          if (exactTotal > 0xffff_ffffn) throw new RangeError("WASI WFST arc count exceeds u32");
          total = Number(exactTotal);
          values = page.arcs;
        }
        const arcs = values.map((arc) => providerArc(arc, unitDomain));
        if (
          start > total
          || arcs.length > capacity
          || start + arcs.length > total
          || (capacity !== 0 && arcs.length === 0 && start < total)
        ) {
          throw new RangeError("WFST provider returned invalid arc paging");
        }
        const memory = memoryView();
        for (const [index, arc] of arcs.entries()) {
          const record = arcsPointer + index * 40;
          memory.setBigUint64(record, arc.input, true);
          memory.setBigUint64(record + 8, arc.output, true);
          memory.setBigUint64(record + 16, arc.target, true);
          memory.setFloat64(record + 24, arc.weight, true);
          memory.setUint8(record + 32, arc.hasInput);
          memory.setUint8(record + 33, arc.hasOutput);
          for (let reserved = 34; reserved < 40; reserved += 1) memory.setUint8(record + reserved, 0);
        }
        memory.setUint32(writtenPointer, arcs.length, true);
        memory.setUint32(totalPointer, total, true);
      });
    },
  };
  const imports = wasi.getImportObject();
  imports.vinary_tree_host = host;
  const instance = await WebAssembly.instantiate(module, imports);
  wasi.initialize(instance);
  ffi = instance.exports;
  const runtimeIdentity = Object.freeze({ implementation: "vinary-tree-wasi-preview1-v1", instance });

  function view() { return new DataView(ffi.memory.buffer); }
  function bytes() { return new Uint8Array(ffi.memory.buffer); }
  function failure(value) {
    const unsigned = value >>> 0;
    if (unsigned !== FAILURE) return unsigned;
    const pointer = ffi.vt_error_pointer();
    const length = ffi.vt_error_length();
    throw new Error(decoder.decode(bytes().slice(pointer, pointer + length)));
  }
  function withBytes(value, operation) {
    const encoded = typeof value === "string" ? encoder.encode(value) : value;
    const pointer = ffi.vt_alloc(encoded.length);
    try {
      bytes().set(encoded, pointer);
      return operation(pointer, encoded.length);
    } finally {
      ffi.vt_dealloc(pointer, encoded.length);
    }
  }
  function withTokens(value, operation) {
    if (!(value instanceof BigUint64Array)) {
      throw new TypeError("u64 dictionary keys require BigUint64Array");
    }
    const encoded = new Uint8Array(value.length * 8);
    const data = new DataView(encoded.buffer);
    for (let index = 0; index < value.length; index += 1) {
      data.setBigUint64(index * 8, value[index], true);
    }
    return withBytes(encoded, (pointer) => operation(pointer, value.length));
  }
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

  class Dictionary {
    #handle;
    #persistent;
    constructor(handle, unitDomain, persistent) {
      this.#handle = failure(handle);
      this.#persistent = persistent;
      Object.defineProperties(this, {
        interfaceId: { value: "vt.dictionary.v1", enumerable: true },
        runtimeIdentity: { value: runtimeIdentity, enumerable: true },
        unitDomain: { value: unitDomain, enumerable: true },
        valueDomain: { value: "optional-u64", enumerable: true },
      });
    }
    get _handle() {
      if (this.#handle === 0) throw new Error("dictionary is closed");
      return this.#handle;
    }
    get size() { return failure(ffi.vt_dictionary_len(this._handle)); }
    put(term, value = null) {
      if (value !== null && (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn)) {
        throw new RangeError("dictionary value must be null or an unsigned 64-bit bigint");
      }
      if (term instanceof BigUint64Array) {
        return withTokens(term, (pointer, length) => Boolean(failure(
          ffi.vt_dictionary_put_u64(this._handle, pointer, length, Number(value !== null), value ?? 0n),
        )));
      }
      if (typeof term !== "string" && !(term instanceof Uint8Array)) {
        throw new TypeError("dictionary key must be a string, Uint8Array, or BigUint64Array");
      }
      return withBytes(term, (pointer, length) => Boolean(failure(
        ffi.vt_dictionary_put_text(this._handle, pointer, length, Number(value !== null), value ?? 0n),
      )));
    }
    putU64(term, value = null) { return this.put(term, value); }
    set(term, value = null) { this.put(term, value); return this; }
    remove(term) {
      if (term instanceof BigUint64Array) {
        return withTokens(term, (pointer, length) => Boolean(failure(
          ffi.vt_dictionary_remove_u64(this._handle, pointer, length),
        )));
      }
      return withBytes(term, (pointer, length) => Boolean(failure(
        ffi.vt_dictionary_remove_text(this._handle, pointer, length),
      )));
    }
    removeU64(term) { return this.remove(term); }
    delete(term) { return this.remove(term); }
    lookup(term) {
      const decode = (termPointer, termLength, operation) => {
        const output = ffi.vt_alloc(16);
        try {
          failure(operation(this._handle, termPointer, termLength, output));
          const memory = view();
          const found = memory.getUint32(output, true) !== 0;
          const present = memory.getUint32(output + 4, true) !== 0;
          return { found, value: present ? memory.getBigUint64(output + 8, true) : null };
        } finally {
          ffi.vt_dealloc(output, 16);
        }
      };
      return term instanceof BigUint64Array
        ? withTokens(term, (pointer, length) => decode(pointer, length, ffi.vt_dictionary_get_u64))
        : withBytes(term, (pointer, length) => decode(pointer, length, ffi.vt_dictionary_get_text));
    }
    lookupU64(term) { return this.lookup(term); }
    get(term) { const result = this.lookup(term); return result.found ? result.value : undefined; }
    getU64(term) { return this.get(term); }
    has(term) { return this.lookup(term).found; }
    hasU64(term) { return this.has(term); }
    streamEntries() { return new DictionaryEntryCursor(ffi.vt_dictionary_entries_open(this._handle)); }
    algebra(right, operation, valueMerge = "last") {
      if (!(right instanceof Dictionary)) {
        throw new TypeError("dictionary algebra requires a dictionary from this runtime");
      }
      return new Dictionary(
        ffi.vt_dictionary_algebra(
          this._handle,
          right._handle,
          select(ALGEBRA_OPERATIONS, operation, "dictionary algebra operation"),
          select(VALUE_MERGES, valueMerge, "dictionary value-merge policy"),
        ),
        this.unitDomain,
        false,
      );
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
    clear() { failure(ffi.vt_dictionary_clear(this._handle)); }
    compact() { return failure(ffi.vt_dictionary_compact(this._handle)); }
    checkpoint() {
      if (!this.#persistent) throw new Error("in-memory dictionaries do not checkpoint");
      failure(ffi.vt_dictionary_checkpoint(this._handle));
    }
    close() {
      if (this.#handle !== 0) {
        ffi.vt_handle_close(this.#handle);
        this.#handle = 0;
      }
    }
    [Symbol.dispose]() { this.close(); }
  }

  class DictionaryEntryCursor {
    #handle;
    #pending = [];
    #offset = 0;
    constructor(handle) {
      this.#handle = failure(handle);
      this.size = failure(ffi.vt_entry_cursor_len(this.#handle));
      this.identity = null;
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
        if (result.length === maximum || this.#handle === 0) break;
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
      if (this.#handle === 0) return [];
      const count = failure(ffi.vt_entry_cursor_next_batch(this.#handle, maximum));
      if (count === 0) return [];
      let record = failure(ffi.vt_entry_cursor_batch_pointer(this.#handle));
      const memory = view();
      const output = [];
      for (let index = 0; index < count; index += 1) {
        const payloadLength = memory.getUint32(record, true);
        const domain = memory.getUint32(record + 4, true);
        const present = memory.getUint32(record + 8, true) !== 0;
        const value = present ? memory.getBigUint64(record + 16, true) : null;
        const payload = record + ENTRY_RECORD_HEADER_SIZE;
        let key;
        if (domain === 0) {
          key = bytes().slice(payload, payload + payloadLength);
        } else if (domain === 1) {
          key = decoder.decode(bytes().slice(payload, payload + payloadLength));
        } else {
          if (payloadLength % 8 !== 0) throw new Error("invalid u64 dictionary entry payload");
          key = new BigUint64Array(payloadLength / 8);
          for (let token = 0; token < key.length; token += 1) {
            key[token] = memory.getBigUint64(payload + token * 8, true);
          }
        }
        output.push([key, value]);
        record = payload + payloadLength;
      }
      return output;
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
    return() { this.close(); return { done: true, value: undefined }; }
    close() {
      if (this.#handle !== 0) {
        ffi.vt_handle_close(this.#handle);
        this.#handle = 0;
        this.#pending = [];
        this.#offset = 0;
      }
    }
    [Symbol.dispose]() { this.close(); }
  }

  class QueryCursor {
    #handle;
    #pending = [];
    #offset = 0;
    constructor(handle) { this.#handle = failure(handle); }
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
        if (result.length === maximum || this.#handle === 0) break;
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
      if (this.#handle === 0) return [];
      const count = failure(ffi.vt_cursor_next_batch(this.#handle, maximum));
      if (count === 0) return [];
      const pointer = failure(ffi.vt_cursor_batch_pointer(this.#handle));
      const memory = view();
      const output = [];
      for (let index = 0; index < count; index += 1) {
        const record = pointer + index * RECORD_SIZE;
        const termPointer = memory.getUint32(record, true);
        const termLength = memory.getUint32(record + 4, true);
        const domain = memory.getUint32(record + 8, true);
        let term;
        if (domain === 0) {
          term = { domain: "byte", value: bytes().slice(termPointer, termPointer + termLength) };
        } else if (domain === 1) {
          term = { domain: "unicode", value: decoder.decode(bytes().slice(termPointer, termPointer + termLength)) };
        } else {
          const values = new BigUint64Array(termLength);
          for (let offset = 0; offset < termLength; offset += 1) {
            values[offset] = memory.getBigUint64(termPointer + offset * 8, true);
          }
          term = { domain: "u64", value: values };
        }
        output.push({
          term,
          distance: memory.getUint32(record + 12, true),
          id: memory.getUint32(record + 16, true) === 0
            ? null
            : memory.getBigUint64(record + 24, true),
        });
      }
      return output;
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
      if (this.#handle !== 0) {
        ffi.vt_handle_close(this.#handle);
        this.#handle = 0;
        this.#pending = [];
        this.#offset = 0;
      }
    }
    return() { this.close(); return { done: true, value: undefined }; }
    [Symbol.dispose]() { this.close(); }
  }

  class Transducer {
    #handle;
    constructor(dictionary, algorithm = "standard") {
      if (dictionary?.runtimeIdentity !== runtimeIdentity || dictionary.interfaceId !== "vt.dictionary.v1") {
        throw new TypeError("dictionary belongs to a different Vinary Tree runtime");
      }
      this.#handle = failure(ffi.vt_transducer_new(
        dictionary._handle,
        select(ALGORITHMS, algorithm, "algorithm"),
      ));
    }
    get _handle() {
      if (this.#handle === 0) throw new Error("transducer is closed");
      return this.#handle;
    }
    query(query, maximumDistance, order = "traversal") {
      const selectedOrder = select(ORDERS, order, "query order");
      if (typeof query === "string") {
        return withBytes(query, (pointer, length) => new QueryCursor(ffi.vt_query_text(
          this.#handle, pointer, length, maximumDistance, selectedOrder,
        )));
      }
      if (query instanceof BigUint64Array) {
        return withTokens(query, (pointer, length) => new QueryCursor(ffi.vt_query_u64(
          this.#handle, pointer, length, maximumDistance, selectedOrder,
        )));
      }
      if (query instanceof Uint8Array) {
        return withBytes(query, (pointer, length) => new QueryCursor(ffi.vt_query_bytes(
          this.#handle, pointer, length, maximumDistance, selectedOrder,
        )));
      }
      throw new TypeError("query requires text, Uint8Array, or BigUint64Array");
    }
    close() {
      if (this.#handle !== 0) {
        ffi.vt_handle_close(this.#handle);
        this.#handle = 0;
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
      this.#handle = failure(ffi.vt_query_cache_new(
        transducer._handle,
        cacheLimit(options.maximumEntries, 1024, "maximumEntries"),
        cacheLimit(options.maximumWeight, 64 * 1024 * 1024, "maximumWeight"),
      ));
    }
    get _handle() {
      if (this.#handle === 0) throw new Error("query cache is closed");
      return this.#handle;
    }
    get stats() {
      const output = ffi.vt_alloc(64);
      try {
        failure(ffi.vt_query_cache_stats(this._handle, output));
        const memory = view();
        return Object.freeze({
          requests: memory.getBigUint64(output, true),
          hits: memory.getBigUint64(output + 8, true),
          misses: memory.getBigUint64(output + 16, true),
          admissions: memory.getBigUint64(output + 24, true),
          rejections: memory.getBigUint64(output + 32, true),
          evictions: memory.getBigUint64(output + 40, true),
          residentEntries: Number(memory.getBigUint64(output + 48, true)),
          residentWeight: Number(memory.getBigUint64(output + 56, true)),
        });
      } finally {
        ffi.vt_dealloc(output, 64);
      }
    }
    query(query, maximumDistance, order = "traversal") {
      const selectedOrder = select(ORDERS, order, "query order");
      if (typeof query === "string") {
        return withBytes(query, (pointer, length) => new QueryCursor(
          ffi.vt_query_cache_query_text(
            this._handle, pointer, length, maximumDistance, selectedOrder,
          ),
        ));
      }
      if (query instanceof BigUint64Array) {
        return withTokens(query, (pointer, length) => new QueryCursor(
          ffi.vt_query_cache_query_u64(
            this._handle, pointer, length, maximumDistance, selectedOrder,
          ),
        ));
      }
      if (query instanceof Uint8Array) {
        return withBytes(query, (pointer, length) => new QueryCursor(
          ffi.vt_query_cache_query_bytes(
            this._handle, pointer, length, maximumDistance, selectedOrder,
          ),
        ));
      }
      throw new TypeError("cached query requires text, Uint8Array, or BigUint64Array");
    }
    clear() { failure(ffi.vt_query_cache_clear(this._handle)); return this; }
    resetStats() { failure(ffi.vt_query_cache_reset_stats(this._handle)); return this; }
    close() {
      if (this.#handle !== 0) {
        ffi.vt_handle_close(this.#handle);
        this.#handle = 0;
      }
    }
    [Symbol.dispose]() { this.close(); }
  }

  class Wfst {
    #handle;
    constructor(handle) {
      this.#handle = failure(handle);
      Object.defineProperties(this, {
        interfaceId: { value: "vt.scalar-wfst.1", enumerable: true },
        runtimeIdentity: { value: runtimeIdentity, enumerable: true },
      });
    }
    get _handle() {
      if (this.#handle === 0) throw new Error("WFST is closed");
      return this.#handle;
    }
    get weightDomain() {
      const value = failure(ffi.vt_wfst_weight_domain(this._handle));
      const name = WEIGHT_DOMAINS.get(value);
      if (name === undefined) throw new Error(`unknown WFST weight domain ${value}`);
      return name;
    }
    get unitDomain() {
      const value = failure(ffi.vt_wfst_unit_domain(this._handle));
      const name = WFST_UNIT_DOMAIN_NAMES.get(value);
      if (name === undefined) throw new Error(`unknown WFST unit domain ${value}`);
      return name;
    }
    start() {
      const output = ffi.vt_alloc(8);
      try {
        failure(ffi.vt_wfst_start(this._handle, output));
        return view().getBigUint64(output, true);
      } finally {
        ffi.vt_dealloc(output, 8);
      }
    }
    state(state) {
      if (typeof state !== "bigint" || state < 0n || state > 0xffff_ffff_ffff_ffffn) {
        throw new RangeError("WFST state must be an unsigned 64-bit bigint");
      }
      const unitDomain = this.unitDomain;
      const handle = this._handle;
      const count = failure(ffi.vt_wfst_state(handle, state));
      const pointer = failure(ffi.vt_wfst_state_pointer(handle));
      const memory = view();
      const arcs = [];
      const label = (raw, present) => {
        if (!present) return null;
        if (unitDomain === "byte") return Number(raw);
        if (unitDomain === "unicode") return String.fromCodePoint(Number(raw));
        return raw;
      };
      for (let index = 0; index < count; index += 1) {
        const record = pointer + 16 + index * 40;
        const hasInput = memory.getUint32(record + 32, true) !== 0;
        const hasOutput = memory.getUint32(record + 36, true) !== 0;
        arcs.push({
          input: label(memory.getBigUint64(record, true), hasInput),
          output: label(memory.getBigUint64(record + 8, true), hasOutput),
          target: memory.getBigUint64(record + 16, true),
          weight: memory.getFloat64(record + 24, true),
        });
      }
      return {
        valid: memory.getUint32(pointer, true) !== 0,
        final: memory.getUint32(pointer + 4, true) !== 0,
        finalWeight: memory.getFloat64(pointer + 8, true),
        arcs,
      };
    }
    close() {
      if (this.#handle !== 0) {
        ffi.vt_handle_close(this.#handle);
        this.#handle = 0;
      }
    }
    [Symbol.dispose]() { this.close(); }
  }

  class WfstBuilder {
    #handle = failure(ffi.vt_wfst_builder_new());
    get _handle() {
      if (this.#handle === 0) throw new Error("WFST builder is closed");
      return this.#handle;
    }
    addState() { return failure(ffi.vt_wfst_builder_add_state(this._handle)); }
    setStart(state) { failure(ffi.vt_wfst_builder_set_start(this._handle, state)); }
    setFinal(state, weight = 0) { failure(ffi.vt_wfst_builder_set_final(this._handle, state, weight)); }
    addArc(from, input, output, to, weight = 0) {
      const label = (value) => {
        if (value === null || value === undefined) return [0, 0];
        if (typeof value !== "string" || [...value].length !== 1) {
          throw new TypeError("arc label must contain one Unicode scalar or be null");
        }
        return [value.codePointAt(0), 1];
      };
      const [inputLabel, hasInput] = label(input);
      const [outputLabel, hasOutput] = label(output);
      failure(ffi.vt_wfst_builder_add_arc(
        this._handle, from, inputLabel, hasInput, outputLabel, hasOutput, to, weight,
      ));
    }
    build() {
      const handle = this._handle;
      const result = new Wfst(ffi.vt_wfst_builder_build(handle));
      this.#handle = 0;
      return result;
    }
    close() {
      if (this.#handle !== 0) {
        ffi.vt_handle_close(this.#handle);
        this.#handle = 0;
      }
    }
    [Symbol.dispose]() { this.close(); }
  }

  const libdictenstein = Object.freeze({
    runtimeIdentity,
    dynamicDawg(unitDomain = "unicode") {
      return new Dictionary(
        ffi.vt_dynamic_dawg_new(select(DOMAINS, unitDomain, "unit domain")),
        unitDomain,
        false,
      );
    },
    createPersistentARTrie(path, unitDomain = "unicode") {
      return withBytes(path, (pointer, length) => new Dictionary(
        ffi.vt_persistent_artrie_create(pointer, length, select(DOMAINS, unitDomain, "unit domain")),
        unitDomain,
        true,
      ));
    },
    openPersistentARTrie(path, unitDomain = "unicode") {
      return withBytes(path, (pointer, length) => new Dictionary(
        ffi.vt_persistent_artrie_open(pointer, length, select(DOMAINS, unitDomain, "unit domain")),
        unitDomain,
        true,
      ));
    },
  });
  const liblevenshtein = Object.freeze({
    runtimeIdentity,
    transducer(dictionary, algorithm = "standard") { return new Transducer(dictionary, algorithm); },
    queryCache(transducer, options) { return new QueryCache(transducer, options); },
  });

  const llingLlang = Object.freeze({
    runtimeIdentity,
    vectorWfst() { return new WfstBuilder(); },
    scalarWfst(provider, options = {}) {
      const validated = requireScalarWfstProvider(provider);
      const selected = hostWfstOptions(options);
      const hostHandle = providers.insert(validated, selected.unitDomain);
      const guestHandle = ffi.vt_host_wfst_new(
        hostHandle,
        selected.unitDomain,
        selected.weightDomain,
        selected.flags,
      );
      if ((guestHandle >>> 0) === FAILURE) {
        providers.release(hostHandle);
        failure(guestHandle);
      }
      return new Wfst(guestHandle);
    },
    compose(first, second) {
      if (first?.runtimeIdentity !== runtimeIdentity || second?.runtimeIdentity !== runtimeIdentity) {
        throw new TypeError("WFST belongs to a different Vinary Tree runtime");
      }
      return new Wfst(ffi.vt_wfst_compose(first._handle, second._handle));
    },
  });

  const duallity = Object.freeze({
    runtimeIdentity,
    wfst(dictionary, query, maximumDistance, algorithm = "standard", kind = "levenshtein") {
      if (dictionary?.runtimeIdentity !== runtimeIdentity || dictionary.interfaceId !== "vt.dictionary.v1") {
        throw new TypeError("dictionary belongs to a different Vinary Tree runtime");
      }
      return withBytes(query, (pointer, length) => new Wfst(ffi.vt_duallity_wfst_new(
        dictionary._handle,
        pointer,
        length,
        maximumDistance,
        select(ALGORITHMS, algorithm, "algorithm"),
        select(DUALLITY_KINDS, kind, "duallity WFST kind"),
      )));
    },
  });

  return Object.freeze({ runtimeIdentity, libdictenstein, liblevenshtein, llingLlang, duallity });
}
