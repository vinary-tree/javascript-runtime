// Versioned, host-independent transport for duallity's revision-3 options.
// All three JavaScript backends consume the same validated byte sequence.
const encoder = new TextEncoder();
const MAGIC = 0x31434644; // "DFC1" in little-endian order.
const LIMIT_NAMES = Object.freeze([
  "maxQueryBytes", "maxQueryScalars", "maxOperationSourceScalars",
  "maxOperationQueryScalars", "maxRetainedDictionaryNodes",
  "maxRetainedWfstStates", "maxPathsPerExpansion", "maxWorkUnitsPerExpansion",
]);
const KINDS = Object.freeze({
  levenshtein: 0,
  "universal-standard": 1,
  "universal-transposition": 2,
  "universal-merge-and-split": 3,
  "generalized-standard": 4,
  "generalized-transposition": 5,
  "generalized-merge-and-split": 6,
  "generalized-phonetic": 7,
  fzf: 8,
});
const ALGORITHMS = Object.freeze({
  standard: 0, transposition: 1, "merge-and-split": 2, "damerau-levenshtein": 3,
});
const POLICIES = Object.freeze({ all: 0, none: 1, lru: 2 });
const APPLICABILITY = Object.freeze({
  any: 0, equal: 1, "adjacent-transpose": 2, listed: 3,
});

function record(value, name, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (!keys.includes(key)) throw new TypeError(`unknown ${name} option: ${String(key)}`);
  }
  return value;
}

function select(table, value, name) {
  if (typeof value !== "string" || !Object.hasOwn(table, value)) {
    throw new TypeError(`unknown ${name}: ${String(value)}`);
  }
  return table[value];
}

function uint(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 0 through ${maximum}`);
  }
  return value;
}

function text(value, name, { nonempty = false } = {}) {
  if (typeof value !== "string" || (nonempty && value.length === 0)) {
    throw new TypeError(`${name} must be ${nonempty ? "a nonempty" : "a"} string`);
  }
  if (value.length > 1_048_576) throw new RangeError(`${name} exceeds 1 MiB`);
  return encoder.encode(value);
}

class Writer {
  bytes = [];
  u32(value) {
    for (let shift = 0; shift < 32; shift += 8) this.bytes.push((value >>> shift) & 255);
  }
  u64(value) {
    let rest = BigInt(value);
    for (let index = 0; index < 8; index += 1) {
      this.bytes.push(Number(rest & 255n));
      rest >>= 8n;
    }
  }
  f64(value) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.bytes.push(...bytes);
  }
  text(bytes) {
    this.u32(bytes.length);
    for (const byte of bytes) this.bytes.push(byte);
  }
  finish() { return Uint8Array.from(this.bytes); }
}

/**
 * Encode the complete revision-3 configuration without host-specific pointer
 * layouts. The native parser still validates every record before calling C.
 */
export function encodeDuallityConfig(input) {
  const options = record(input, "duallity configuration", [
    "kind", "algorithm", "maximumDistance", "cachePolicy", "cacheCapacity",
    "limits", "operations",
  ]);
  const kind = select(KINDS, options.kind ?? "levenshtein", "duallity WFST kind");
  const algorithm = select(ALGORITHMS, options.algorithm ?? "standard", "algorithm");
  const maximumDistance = uint(options.maximumDistance ?? 2, "maximumDistance");
  const cachePolicy = select(POLICIES, options.cachePolicy ?? "all", "cache policy");
  const cacheCapacity = uint(options.cacheCapacity ?? 0, "cacheCapacity");
  if (cachePolicy !== 2 && cacheCapacity !== 0) {
    throw new RangeError("only lru accepts a nonzero cacheCapacity");
  }
  if (kind !== 0 && algorithm !== 0) {
    throw new TypeError("only levenshtein accepts a nonstandard algorithm");
  }
  if (kind === 8 && maximumDistance !== 0) {
    throw new RangeError("fzf requires maximumDistance 0");
  }
  if (kind !== 0 && kind !== 8 && maximumDistance > 255) {
    throw new RangeError("universal and generalized distances must fit u8");
  }
  const generalized = kind >= 4 && kind <= 7;
  if (!generalized && (options.limits !== undefined || options.operations !== undefined)) {
    throw new TypeError("limits and operations require a generalized WFST kind");
  }
  let limits = null;
  if (options.limits !== undefined) {
    const selected = record(options.limits, "limits", LIMIT_NAMES);
    limits = LIMIT_NAMES.map((name) => {
      if (!Object.hasOwn(selected, name)) throw new TypeError(`missing limits.${name}`);
      return uint(selected[name], `limits.${name}`);
    });
    if (limits[4] === 0 || limits[5] === 0) {
      throw new RangeError("retained dictionary-node and WFST-state limits must be positive");
    }
  }
  const operations = options.operations ?? [];
  if (!Array.isArray(operations) || operations.length > 4096) {
    throw new TypeError("operations must be an array of at most 4096 records");
  }
  const writer = new Writer();
  writer.u32(MAGIC);
  writer.u32(1);
  writer.u32(kind);
  writer.u32(algorithm);
  writer.u64(maximumDistance);
  writer.u32(cachePolicy);
  writer.u64(cacheCapacity);
  writer.u32(limits === null ? 0 : 1);
  writer.u32(operations.length);
  if (limits !== null) for (const limit of limits) writer.u64(limit);
  let pairCount = 0;
  let textBytes = 0;
  let width = 0;
  for (const [index, raw] of operations.entries()) {
    const op = record(raw, `operation ${index}`, [
      "name", "consumeX", "consumeY", "weight", "applicability", "restrictions",
    ]);
    const consumeX = uint(op.consumeX, `operation ${index}.consumeX`, 4096);
    const consumeY = uint(op.consumeY, `operation ${index}.consumeY`, 4096);
    width += consumeX + consumeY;
    if (width > 4096 || consumeX + consumeY === 0) {
      throw new RangeError("custom operation grammar has zero progress or exceeds width 4096");
    }
    if (typeof op.weight !== "number" || !Number.isFinite(op.weight) || op.weight < 0 ||
        (op.weight === 0 && consumeX !== consumeY)) {
      throw new RangeError(`operation ${index}.weight is invalid`);
    }
    const applicability = select(APPLICABILITY, op.applicability ?? "any", "applicability");
    const name = text(op.name, `operation ${index}.name`, { nonempty: true });
    if (name.length > 1024 || name.includes(0)) {
      throw new RangeError(`operation ${index}.name exceeds 1024 bytes or contains NUL`);
    }
    const restrictions = op.restrictions ?? [];
    if (!Array.isArray(restrictions)) throw new TypeError("restrictions must be an array");
    pairCount += restrictions.length;
    if (pairCount > 4096) throw new RangeError("restriction count exceeds 4096");
    if ((applicability === 3) !== (restrictions.length > 0) ||
        (applicability === 1 && consumeX !== consumeY) ||
        (applicability === 2 && (consumeX !== 2 || consumeY !== 2))) {
      throw new TypeError(`operation ${index} has incompatible applicability and restrictions`);
    }
    writer.u64(consumeX);
    writer.u64(consumeY);
    writer.f64(op.weight);
    writer.u32(applicability);
    writer.text(name);
    writer.u32(restrictions.length);
    textBytes += name.length;
    if (textBytes > 1_048_576) throw new RangeError("custom text exceeds 1 MiB");
    for (const [pairIndex, rawPair] of restrictions.entries()) {
      const pair = record(rawPair, `restriction ${pairIndex}`, ["source", "target"]);
      const source = text(pair.source, "restriction source", { nonempty: true });
      const target = text(pair.target, "restriction target", { nonempty: true });
      if (Array.from(pair.source).length !== consumeX ||
          Array.from(pair.target).length !== consumeY) {
        throw new RangeError(`restriction ${pairIndex} scalar lengths disagree with operation arity`);
      }
      textBytes += source.length + target.length;
      if (textBytes > 1_048_576) throw new RangeError("custom text exceeds 1 MiB");
      writer.text(source);
      writer.text(target);
    }
  }
  return writer.finish();
}

export const duallityConfigWireVersion = 1;

const REVERSE_KINDS = Object.freeze(Object.keys(KINDS));
const REVERSE_ALGORITHMS = Object.freeze(Object.keys(ALGORITHMS));
const REVERSE_POLICIES = Object.freeze(Object.keys(POLICIES));
const REVERSE_APPLICABILITY = Object.freeze(Object.keys(APPLICABILITY));
const decoder = new TextDecoder("utf-8", { fatal: true });

class Reader {
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("duallity wire value must be Uint8Array");
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }
  take(count) {
    if (!Number.isSafeInteger(count) || count < 0 || this.offset + count > this.view.byteLength) {
      throw new RangeError("truncated duallity wire value");
    }
    const offset = this.offset;
    this.offset += count;
    return offset;
  }
  u32() { return this.view.getUint32(this.take(4), true); }
  u64() { return this.view.getBigUint64(this.take(8), true); }
  safeU64(name) {
    const value = this.u64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds safe JS integer`);
    return Number(value);
  }
  f64() { return this.view.getFloat64(this.take(8), true); }
  text() {
    const count = this.u32();
    const offset = this.take(count);
    return decoder.decode(new Uint8Array(this.view.buffer, this.view.byteOffset + offset, count));
  }
  end() {
    if (this.offset !== this.view.byteLength) throw new RangeError("duallity wire value has trailing bytes");
  }
}

/** Decode a native-owned revision-3 readback record. */
export function decodeDuallityConfig(bytes) {
  const reader = new Reader(bytes);
  if (reader.u32() !== MAGIC || reader.u32() !== 1) {
    throw new TypeError("unknown duallity configuration wire format");
  }
  const kind = REVERSE_KINDS[reader.u32()];
  const algorithm = REVERSE_ALGORITHMS[reader.u32()];
  const maximumDistance = reader.safeU64("maximumDistance");
  const cachePolicy = REVERSE_POLICIES[reader.u32()];
  const cacheCapacity = reader.safeU64("cacheCapacity");
  const hasLimits = reader.u32();
  const operationCount = reader.u32();
  if (kind === undefined || algorithm === undefined || cachePolicy === undefined ||
      hasLimits > 1 || operationCount > 4096) {
    throw new TypeError("invalid native duallity option selector or count");
  }
  const result = { kind, algorithm, maximumDistance, cachePolicy, cacheCapacity };
  if (hasLimits === 1) {
    result.limits = Object.fromEntries(LIMIT_NAMES.map((name) => [name, reader.safeU64(name)]));
  }
  if (operationCount > 0) {
    result.operations = [];
    for (let index = 0; index < operationCount; index += 1) {
      const consumeX = reader.safeU64("consumeX");
      const consumeY = reader.safeU64("consumeY");
      const weight = reader.f64();
      const applicability = REVERSE_APPLICABILITY[reader.u32()];
      const name = reader.text();
      const pairCount = reader.u32();
      if (applicability === undefined || pairCount > 4096) {
        throw new TypeError("invalid native duallity operation");
      }
      const restrictions = [];
      for (let pair = 0; pair < pairCount; pair += 1) {
        restrictions.push({ source: reader.text(), target: reader.text() });
      }
      result.operations.push({ name, consumeX, consumeY, weight, applicability, restrictions });
    }
  }
  reader.end();
  return result;
}

/** Cache counters are u64; preserve precision as BigInt. */
export function decodeDuallityStatistics(bytes) {
  const reader = new Reader(bytes);
  const names = [
    "hits", "misses", "faults", "uncacheableResults", "insertions", "evictions",
    "racedPublications", "clears", "residentStates", "recencyRecords",
  ];
  const result = Object.fromEntries(names.map((name) => [name, reader.u64()]));
  reader.end();
  return result;
}

export function duallityPolicyValue(value) {
  return select(POLICIES, value, "cache policy");
}
