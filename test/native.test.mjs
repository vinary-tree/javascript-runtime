import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { libdictenstein, liblevenshtein, llingLlang, duallity, runtimeIdentity } from "../native.mjs";

function collect(cursor) {
  try { return [...cursor].map(({ term, distance, id }) => [term.value, distance, id]); }
  finally { cursor.close(); }
}

/** Extract every `export interface` body from a .d.ts source. */
function interfaceBodies(declarations) {
  const result = new Map();
  for (const match of declarations.matchAll(/export interface (\w+)[^{]*\{/g)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < declarations.length && depth > 0) {
      if (declarations[index] === "{") depth += 1;
      if (declarations[index] === "}") depth -= 1;
      index += 1;
    }
    result.set(match[1], declarations.slice(start, index - 1));
  }
  return result;
}

/** Split one interface body into declared method and property names. */
function declaredMembers(body) {
  const methods = new Set();
  const properties = new Set();
  // Members terminate at semicolons outside every nested brace, paren, and
  // bracket, so inline object types and parameter lists never leak members.
  const fragments = [];
  let depth = 0;
  let current = "";
  for (const character of body) {
    if ("{([".includes(character)) depth += 1;
    if ("})]".includes(character)) depth -= 1;
    if (character === ";" && depth === 0) {
      fragments.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  fragments.push(current);
  for (const fragment of fragments) {
    const declaration = fragment.trim();
    const method = declaration.match(/^(\w+)\s*[<(]/);
    const property = declaration.match(/^readonly\s+(\w+)\??:/)
      ?? declaration.match(/^(\w+)\??:/);
    if (method) methods.add(method[1]);
    else if (property) properties.add(property[1]);
  }
  return { methods, properties };
}

const maximumLatticeDomain = "example.maximum1";

function maximumOperandValue(operand) {
  const provider = operand.localValue;
  if (operand.domainId !== maximumLatticeDomain ||
      provider === null || typeof provider.value !== "number") {
    throw new TypeError("foreign maximum lattice value");
  }
  return provider.value;
}

function bareMaximumLattice(value) {
  return {
    value,
    join(other) { return bareMaximumLattice(Math.max(value, maximumOperandValue(other))); },
    meet(other) { return bareMaximumLattice(Math.min(value, maximumOperandValue(other))); },
    equal(other) { return value === maximumOperandValue(other); },
    diagnostic() { return `maximum(${value})`; },
  };
}

class MaximumLatticeProvider {
  constructor(value, telemetry = { joins: 0, meets: 0 }) {
    this.value = value;
    this.telemetry = telemetry;
  }
  join(other) {
    this.telemetry.joins += 1;
    return new MaximumLatticeProvider(
      Math.max(this.value, maximumOperandValue(other)), this.telemetry,
    );
  }
  meet(other) {
    this.telemetry.meets += 1;
    return new MaximumLatticeProvider(
      Math.min(this.value, maximumOperandValue(other)), this.telemetry,
    );
  }
  equal(other) { return this.value === maximumOperandValue(other); }
  diagnostic() { return `maximum(${this.value})`; }
  stableBytes() { return new TextEncoder().encode(String(this.value)); }
  joinMany(others) {
    this.telemetry.joins += 1;
    return new MaximumLatticeProvider(
      Math.max(this.value, ...others.map(maximumOperandValue)), this.telemetry,
    );
  }
  meetMany(others) {
    this.telemetry.meets += 1;
    return new MaximumLatticeProvider(
      Math.min(this.value, ...others.map(maximumOperandValue)), this.telemetry,
    );
  }
}

class NonnegativeRealSemiring {
  constructor(telemetry = { plusMany: 0, timesMany: 0 }) { this.telemetry = telemetry; }
  zero() { return 0; }
  one() { return 1; }
  plus(left, right) { return left + right; }
  times(left, right) { return left * right; }
  equal(left, right) { return Object.is(left, right); }
  approximatelyEqual(left, right, epsilon) { return Math.abs(left - right) <= epsilon; }
  naturalOrder(left, right) {
    return left < right ? "better" : left > right ? "worse" : "equal";
  }
  diagnostic(value) { return value === undefined ? "nonnegative-real" : `real(${value})`; }
  stableBytes(value) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, false);
    return bytes;
  }
  plusMany(values) { this.telemetry.plusMany += 1; return values.reduce((a, b) => a + b, 0); }
  timesMany(values) { this.telemetry.timesMany += 1; return values.reduce((a, b) => a * b, 1); }
  divide(dividend, divisor) { return divisor === 0 ? null : dividend / divisor; }
  leftDivide(value, divisor) { return divisor === 0 ? null : value / divisor; }
  star(value) { return value < 1 ? 1 / (1 - value) : null; }
  numericalValue(value) { return value; }
  quantize(value, epsilon) { return BigInt(Math.round(value / epsilon)); }
  toProbability(value) { return value; }
}

test("native N-API uses one cross-project runtime and exact snapshots", () => {
  assert.equal(libdictenstein.runtimeIdentity, runtimeIdentity);
  assert.equal(liblevenshtein.runtimeIdentity, runtimeIdentity);
  for (let trace = 0; trace < 64; trace += 1) {
    const dictionary = libdictenstein.dynamicDawg();
    for (let index = 0; index < 16; index += 1) dictionary.put(`t${trace}-${index}`, BigInt(index));
    const transducer = liblevenshtein.transducer(dictionary);
    const expected = collect(transducer.query("", 64, "distance-then-term"));
    const cursor = transducer.query("", 64, "distance-then-term");
    const actual = [cursor.next().value];
    dictionary.remove(`t${trace}-1`);
    dictionary.put(`t${trace}-2`, 999n);
    actual.push(cursor.next().value);
    dictionary.clear();
    dictionary.compact();
    dictionary.put(`after-${trace}`, 1000n);
    actual.push(...cursor);
    assert.deepEqual(actual.map(({ term, distance, id }) => [term.value, distance, id]), expected);
    cursor.close();
    dictionary.close();
    const after = `after-${trace}`;
    assert.deepEqual(collect(transducer.query("", 64)), [[after, [...after].length, 1000n]]);
    transducer.close();
  }
});

test("native DAT, SCDAWG, phonetic, distances, and persistent ARTrie", async () => {
  const dat = libdictenstein.doubleArrayTrie([{ term: "café", value: 7n }, { term: "caff", value: null }]);
  assert.deepEqual(dat.lookup("caff"), { found: true, value: null });
  dat.close();
  const suffixes = libdictenstein.scdawg();
  suffixes.put("cat", 1n);
  suffixes.put("cot", 2n);
  assert.equal(suffixes.containsSubstring("ot"), true);
  assert.equal(suffixes.substringFrequency("t"), 2);
  suffixes.close();
  assert.equal(liblevenshtein.levenshteinDistance("kitten", "sitting"), 3);
  const pattern = liblevenshtein.phoneticPattern("c[ao]t");
  assert.equal(pattern.matches("cat"), true);
  pattern.close();

  const directory = await mkdtemp(join(tmpdir(), "vinary-tree-native-"));
  const path = join(directory, "words.artrie");
  try {
    let dictionary = libdictenstein.createPersistentARTrie(path);
    dictionary.put("cat", 1n);
    dictionary.checkpoint();
    dictionary.close();
    dictionary = libdictenstein.openPersistentARTrie(path);
    assert.deepEqual(dictionary.lookup("cat"), { found: true, value: 1n });
    dictionary.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native dictionaries implement snapshot-coherent Map collection idioms", () => {
  const dictionary = libdictenstein.dynamicDawg();
  assert.equal(dictionary.set("cat", 1n), dictionary);
  dictionary.set("caff", null).set("dog", 3n);
  assert.equal(dictionary.get("cat"), 1n);
  assert.equal(dictionary.get("caff"), null);
  assert.equal(dictionary.get("absent"), undefined);
  assert.equal(dictionary.has("absent"), false);
  assert.deepEqual([...dictionary], [["caff", null], ["cat", 1n], ["dog", 3n]]);
  assert.deepEqual([...dictionary.keys()], ["caff", "cat", "dog"]);
  assert.deepEqual([...dictionary.values()], [null, 1n, 3n]);
  assert.deepEqual([...dictionary.toMap()], [...dictionary]);

  const entries = dictionary.entries();
  const cursor = dictionary.streamEntries();
  assert.equal(cursor.size, 3);
  dictionary.delete("cat");
  dictionary.set("zebra", 9n);
  assert.deepEqual([...entries], [["caff", null], ["cat", 1n], ["dog", 3n]]);
  assert.deepEqual([...cursor], [["caff", null], ["cat", 1n], ["dog", 3n]]);
  assert.equal(Object.isFrozen(dictionary.snapshotEntries()), true);

  const visited = [];
  dictionary.forEach((value, key, owner) => visited.push([key, value, owner === dictionary]));
  assert.deepEqual(visited, [["caff", null, true], ["dog", 3n, true], ["zebra", 9n, true]]);
  dictionary.close();

  const bytes = libdictenstein.dynamicDawg("byte");
  bytes.set(new Uint8Array([0, 255]), 4n);
  const [[byteKey, byteValue]] = [...bytes];
  assert.deepEqual([...byteKey], [0, 255]);
  assert.equal(byteValue, 4n);
  assert.throws(() => bytes.toMap(), /value-equal JavaScript string keys/);
  bytes.close();

  const tokens = libdictenstein.dynamicDawg("u64");
  tokens.set(new BigUint64Array([0n, 2n ** 63n]), null);
  const [[tokenKey, tokenValue]] = [...tokens];
  assert.deepEqual([...tokenKey], [0n, 2n ** 63n]);
  assert.equal(tokenValue, null);
  tokens.close();
});

test("native dictionary algebra delegates snapshot set operations", () => {
  const left = libdictenstein.dynamicDawg();
  left.set("cat", 3n).set("dog", null);
  const right = libdictenstein.dynamicDawg();
  right.set("cat", 7n).set("eel", 11n);
  const defaultAlgebra = left.algebra(right, "union");
  const defaultUnion = left.union(right);
  const union = left.union(right, "lattice-join");
  const intersection = left.intersection(right);
  const difference = left.difference(right);
  const symmetric = left.symmetricDifference(right);
  left.set("fox", 13n);
  assert.deepEqual([...defaultAlgebra], [["cat", 7n], ["dog", null], ["eel", 11n]]);
  assert.deepEqual([...defaultUnion], [["cat", 7n], ["dog", null], ["eel", 11n]]);
  assert.deepEqual([...union], [["cat", 7n], ["dog", null], ["eel", 11n]]);
  assert.deepEqual([...intersection], [["cat", 3n]]);
  assert.deepEqual([...difference], [["dog", null]]);
  assert.deepEqual([...symmetric], [["dog", null], ["eel", 11n]]);
  for (const dictionary of [defaultAlgebra, defaultUnion, union, intersection, difference, symmetric, left, right]) {
    dictionary.close();
  }
});

test("native byte and u64 domains remain typed and streaming", () => {
  const bytes = libdictenstein.dynamicDawg("byte");
  bytes.put("cat", 1n);
  const byteTransducer = liblevenshtein.transducer(bytes);
  assert.deepEqual(collect(byteTransducer.query(new Uint8Array([99, 117, 116]), 1)), [
    [new Uint8Array([99, 97, 116]), 1, 1n],
  ]);
  byteTransducer.close();
  bytes.close();

  const tokens = libdictenstein.dynamicDawg("u64");
  tokens.putU64(new BigUint64Array([1n, 2n]), 8n);
  assert.deepEqual(tokens.lookupU64(new BigUint64Array([1n, 2n])), { found: true, value: 8n });
  const tokenTransducer = liblevenshtein.transducer(tokens);
  assert.deepEqual(collect(tokenTransducer.query(new BigUint64Array([1n, 3n]), 1)), [
    [new BigUint64Array([1n, 2n]), 1, 8n],
  ]);
  tokenTransducer.close();
  tokens.close();
});

test("native bounded query cache is exact, revision-aware, and domain-generic", () => {
  const dictionary = libdictenstein.dynamicDawg();
  dictionary.set("cat", 1n).set("cot", 2n);
  const transducer = liblevenshtein.transducer(dictionary);
  const cache = liblevenshtein.queryCache(transducer, {
    maximumEntries: 4,
    maximumWeight: 4096,
  });
  assert.deepEqual(collect(cache.query("cat", 1, "distance-then-term")), [
    ["cat", 0, 1n], ["cot", 1, 2n],
  ]);
  collect(cache.query("cat", 1, "distance-then-term"));
  assert.equal(cache.stats.requests, 2n);
  assert.equal(cache.stats.hits, 1n);
  dictionary.delete("cot");
  transducer.close();
  dictionary.close();
  assert.deepEqual(collect(cache.query("cat", 1, "distance-then-term")), [
    ["cat", 0, 1n],
  ]);
  assert.equal(cache.stats.misses, 2n);
  cache.clear().resetStats();
  assert.equal(cache.stats.residentEntries, 0);
  assert.equal(cache.stats.requests, 0n);
  cache.close();
  cache.close();
  assert.throws(() => cache.stats, /closed/);
  assert.throws(
    () => liblevenshtein.queryCache({}, {}),
    /transducer from this runtime/,
  );

  const bytes = libdictenstein.dynamicDawg("byte");
  bytes.set(new Uint8Array([99, 97, 116]), 3n);
  const byteTransducer = liblevenshtein.transducer(bytes);
  const byteCache = liblevenshtein.queryCache(byteTransducer);
  assert.deepEqual(collect(byteCache.query(new Uint8Array([99, 117, 116]), 1)), [
    [new Uint8Array([99, 97, 116]), 1, 3n],
  ]);
  byteCache.close();
  byteTransducer.close();
  bytes.close();

  const tokens = libdictenstein.dynamicDawg("u64");
  tokens.set(new BigUint64Array([1n, 2n]), 4n);
  const tokenTransducer = liblevenshtein.transducer(tokens);
  const tokenCache = liblevenshtein.queryCache(tokenTransducer);
  assert.deepEqual(collect(tokenCache.query(new BigUint64Array([1n, 3n]), 1)), [
    [new BigUint64Array([1n, 2n]), 1, 4n],
  ]);
  tokenCache.close();
  tokenTransducer.close();
  tokens.close();
});

test("native thresholded distances mirror their unthresholded siblings", () => {
  // Early-exit semantics: a plain number whenever the true distance fits the
  // maximum (including exactly at it), undefined once the bound is exceeded.
  assert.equal(liblevenshtein.levenshteinDistance("kitten", "sitting"), 3);
  assert.equal(liblevenshtein.levenshteinDistanceThreshold("kitten", "sitting", 3), 3);
  assert.equal(liblevenshtein.levenshteinDistanceThreshold("kitten", "sitting", 64), 3);
  assert.equal(liblevenshtein.levenshteinDistanceThreshold("kitten", "sitting", 2), undefined);

  // OSA counts ca -> abc as 3 while unrestricted Damerau-Levenshtein reaches
  // 2, so the pair also pins each threshold variant to the right algorithm.
  assert.equal(liblevenshtein.damerauDistance("ca", "abc"), 3);
  assert.equal(liblevenshtein.damerauDistanceThreshold("ca", "abc", 3), 3);
  assert.equal(liblevenshtein.damerauDistanceThreshold("ca", "abc", 2), undefined);
  assert.equal(liblevenshtein.trueDamerauDistance("ca", "abc"), 2);
  assert.equal(liblevenshtein.trueDamerauDistanceThreshold("ca", "abc", 2), 2);
  assert.equal(liblevenshtein.trueDamerauDistanceThreshold("ca", "abc", 1), undefined);

  assert.equal(liblevenshtein.damerauDistance("abcd", "acbd"), 1);
  assert.equal(liblevenshtein.damerauDistanceThreshold("abcd", "acbd", 1), 1);
  assert.equal(liblevenshtein.damerauDistanceThreshold("abcd", "acbd", 0), undefined);
});

test("native phonetic pattern size and rule-set size", () => {
  // Any automaton accepting exactly {cat, cot} needs at least four states
  // (a length-three path plus the start) and four labelled transitions.
  const pattern = liblevenshtein.phoneticPattern("c[ao]t");
  const size = pattern.size;
  assert.ok(Number.isSafeInteger(size.states) && size.states >= 4, `states=${size.states}`);
  assert.ok(
    Number.isSafeInteger(size.transitions) && size.transitions >= 4,
    `transitions=${size.transitions}`,
  );
  pattern.close();
  assert.throws(() => pattern.size, /closed/);

  const rules = liblevenshtein.phoneticRules("ph -> f; gh -> ;");
  assert.equal(rules.size, 2);
  assert.equal(rules.apply("graph"), "graf");
  rules.close();
  assert.throws(() => rules.size, /closed/);

  const builtin = liblevenshtein.phoneticRules("english-orthography");
  assert.ok(Number.isSafeInteger(builtin.size) && builtin.size > 0);
  builtin.close();
});

test("native llrePattern compiles an import-free .llre document", () => {
  const pattern = liblevenshtein.llrePattern(`
    @name "Greeting"
    ^hello$
  `);
  try {
    assert.equal(pattern.matches("hello"), true);
    assert.equal(pattern.matches("world"), false);
    assert.ok(pattern.size.states > 0);
    assert.ok(pattern.size.transitions > 0);
  } finally {
    pattern.close();
  }
});

test("native Algorithm selectors dispatch every edit model", () => {
  const dictionary = libdictenstein.dynamicDawg();
  dictionary.put("ab", 1n);
  dictionary.put("c", 2n);
  dictionary.put("abc", 3n);

  const queryWith = (algorithm, input, maximumDistance) => {
    const transducer = liblevenshtein.transducer(dictionary, algorithm);
    try {
      return collect(transducer.query(input, maximumDistance));
    } finally {
      transducer.close();
    }
  };

  try {
    assert.deepEqual(queryWith("standard", "ba", 1), []);
    assert.deepEqual(queryWith("transposition", "ba", 1), [["ab", 1, 1n]]);
    assert.ok(
      queryWith("merge-and-split", "ab", 1)
        .some(([term, distance]) => term === "c" && distance === 1),
    );
    assert.ok(
      queryWith("damerau-levenshtein", "ca", 2)
        .some(([term, distance]) => term === "abc" && distance === 2),
    );
  } finally {
    dictionary.close();
  }
});

test("native QueryOrder selectors distinguish traversal from ranked output", () => {
  const dictionary = libdictenstein.dynamicDawg();
  dictionary.set("cats").set("cat").set("bat");
  const transducer = liblevenshtein.transducer(dictionary);
  try {
    assert.deepEqual(
      collect(transducer.query("cat", 1, "traversal")),
      [["bat", 1, null], ["cat", 0, null], ["cats", 1, null]],
    );
    assert.deepEqual(
      collect(transducer.query("cat", 1, "distance-then-term")),
      [["cat", 0, null], ["bat", 1, null], ["cats", 1, null]],
    );
  } finally {
    transducer.close();
    dictionary.close();
  }
});

test("every index.d.ts member exists on the native path", async () => {
  const declarations = await readFile(new URL("../index.d.ts", import.meta.url), "utf8");
  const interfaces = interfaceBodies(declarations);
  assert.ok(interfaces.size >= 12, "index.d.ts interface scan looks truncated");

  const dictionary = libdictenstein.dynamicDawg();
  dictionary.put("cat", 1n);
  const entryCursor = dictionary.streamEntries();
  const transducer = liblevenshtein.transducer(dictionary);
  const cache = liblevenshtein.queryCache(transducer, { maximumEntries: 2 });
  const cursor = transducer.query("cat", 1);
  const pattern = liblevenshtein.phoneticPattern("c[ao]t");
  const rules = liblevenshtein.phoneticRules("english-orthography");
  const builder = llingLlang.vectorWfst();
  builder.setStart(builder.addState());
  const wfst = duallity.wfst(dictionary, "cat", 1);
  const lattice = llingLlang.lattice(
    new MaximumLatticeProvider(1), { domainId: maximumLatticeDomain },
  );
  const semiring = llingLlang.semiring(
    new NonnegativeRealSemiring(), { domainId: "example.real.sum" },
  );
  const semiringWeight = semiring.one();

  // Interfaces describing plain data records need no live instance; every
  // interface that declares behavior must map to one so a new declaration
  // cannot ship without a runtime member behind it.
  const instances = new Map([
    ["Dictionary", dictionary],
    ["DictionaryEntryCursor", entryCursor],
    ["QueryCursor", cursor],
    ["PhoneticPattern", pattern],
    ["PhoneticRuleSet", rules],
    ["Transducer", transducer],
    ["QueryCache", cache],
    ["Wfst", wfst],
    ["WfstBuilder", builder],
    ["Lattice", lattice],
    ["Semiring", semiring],
    ["SemiringWeight", semiringWeight],
    ["LibdictensteinNamespace", libdictenstein],
    ["LiblevenshteinNamespace", liblevenshtein],
    ["LlingLlangNamespace", llingLlang],
    ["DuallityNamespace", duallity],
  ]);
  try {
    for (const [name, body] of interfaces) {
      const { methods, properties } = declaredMembers(body);
      const instance = instances.get(name);
      if (instance === undefined) {
        assert.equal(
          methods.size,
          0,
          `interface ${name} declares methods but maps to no live instance in this scan`,
        );
        continue;
      }
      for (const method of methods) {
        assert.equal(
          typeof instance[method],
          "function",
          `${name}.${method} must be a function on the native path`,
        );
      }
      for (const property of properties) {
        assert.ok(property in instance, `${name}.${property} must exist on the native path`);
      }
    }
  } finally {
    entryCursor.close();
    cursor.close();
    cache.close();
    wfst.close();
    builder.close();
    lattice.close();
    semiringWeight.close();
    semiring.close();
    transducer.close();
    pattern.close();
    rules.close();
    dictionary.close();
  }
});

test("native reducer and iterator drain a query to the same matches (C5)", () => {
  const dictionary = libdictenstein.dynamicDawg();
  for (const [term, id] of [["cat", 1n], ["cot", 2n], ["cut", 3n], ["scat", null]]) {
    dictionary.put(term, id);
  }
  const transducer = liblevenshtein.transducer(dictionary);
  try {
    const byIterator = collect(transducer.query("cat", 2))
      .map(([value, distance, id]) => `${value}:${distance}:${id}`)
      .sort();
    const reducerCursor = transducer.query("cat", 2);
    const byReducer = reducerCursor
      .reduceBatches((accumulator, batch) => {
        for (const { term, distance, id } of batch) {
          accumulator.push(`${term.value}:${distance}:${id}`);
        }
        return accumulator;
      }, [])
      .sort();
    reducerCursor.close();
    assert.deepEqual(byIterator, byReducer);
    assert.ok(byIterator.length >= 3, `expected at least three matches, got ${byIterator.length}`);
  } finally {
    transducer.close();
    dictionary.close();
  }
});

test("native cursor paging honors batch-size edges (C7)", () => {
  const dictionary = libdictenstein.dynamicDawg();
  // 300 distinct short terms all lie within edit distance 8 of the empty query,
  // so the match set straddles the 256-wide default batch boundary.
  for (let index = 0; index < 300; index += 1) dictionary.put(`term-${index}`, BigInt(index));
  const transducer = liblevenshtein.transducer(dictionary);
  try {
    // C7: a non-positive or non-integer page size is a RangeError, never a
    // silent empty batch that would truncate the stream.
    const guard = transducer.query("", 8);
    assert.throws(() => guard.nextBatch(0), RangeError);
    assert.throws(() => guard.nextBatch(-1), RangeError);
    assert.throws(() => guard.nextBatch(1.5), RangeError);
    guard.close();

    const total = collect(transducer.query("", 8)).length;
    assert.ok(total > 257, `expected a batch-straddling match set, got ${total}`);

    // C7: page sizes 1, 255, 256, 257 each reassemble the complete match set,
    // and no batch ever exceeds its requested page size.
    for (const pageSize of [1, 255, 256, 257]) {
      const cursor = transducer.query("", 8);
      let count = 0;
      for (;;) {
        const batch = cursor.nextBatch(pageSize);
        if (batch.length === 0) break;
        assert.ok(batch.length <= pageSize, `batch ${batch.length} exceeded page ${pageSize}`);
        count += batch.length;
      }
      cursor.close();
      assert.equal(count, total, `page size ${pageSize} lost matches`);
    }
  } finally {
    transducer.close();
    dictionary.close();
  }
});

test("native duallity and lling-llang share retained scalar WFST resources", () => {
  const dictionary = libdictenstein.dynamicDawg();
  dictionary.put("cat", 1n);
  const edit = duallity.wfst(dictionary, "cat", 1);
  dictionary.clear();
  dictionary.close();

  const builder = llingLlang.vectorWfst();
  const states = [builder.addState(), builder.addState(), builder.addState(), builder.addState()];
  builder.setStart(states[0]);
  builder.setFinal(states[3], 0);
  for (const [index, [input, output]] of [["c", "C"], ["a", "A"], ["t", "T"]].entries()) {
    builder.addArc(states[index], input, output, states[index + 1], 0);
  }
  const uppercase = builder.build();
  builder.close();
  const composed = llingLlang.compose(edit, uppercase);
  edit.close();
  uppercase.close();

  const seen = new Set();
  const pending = [[composed.start(), ""]];
  let accepted = false;
  while (pending.length > 0) {
    const [state, output] = pending.pop();
    const key = `${state}:${output}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const expanded = composed.state(state);
    if (expanded.final && output === "CAT") accepted = true;
    for (const arc of expanded.arcs) pending.push([arc.target, output + (arc.output ?? "")]);
  }
  assert.equal(accepted, true);
  composed.close();
});

function linearHostWfstProvider({ paged = false, labels = [["c", "C"], ["a", "A"], ["t", "T"]] } = {}) {
  const outgoing = labels.map(([input, output], index) => [{
    input,
    output,
    target: BigInt(index + 1),
    weight: 0,
  }]);
  outgoing.push([]);
  const pageCalls = [];
  const provider = {
    pageCalls,
    startState: () => 0n,
    stateCount: () => BigInt(outgoing.length),
    stateInfo: (state) => ({
      valid: state >= 0n && state < BigInt(outgoing.length),
      final: state === BigInt(outgoing.length - 1),
      finalWeight: 0,
    }),
    stateArcs: (state) => outgoing[Number(state)] ?? [],
  };
  if (paged) {
    provider.stateArcsPage = (state, start, capacity) => {
      pageCalls.push({ state, start, capacity });
      const arcs = outgoing[Number(state)] ?? [];
      const first = Number(start);
      return {
        arcs: arcs.slice(first, first + capacity),
        total: BigInt(arcs.length),
      };
    };
    provider.stateArcs = () => {
      throw new Error("paged providers must not materialize their complete arc list");
    };
  }
  return provider;
}

test("native JavaScript WFST providers page, compose, snapshot, and dispose exactly", () => {
  const provider = linearHostWfstProvider({ paged: true });
  const uppercase = llingLlang.scalarWfst(provider, {
    unitDomain: "unicode",
    weightDomain: "tropical-f64",
    acyclic: true,
  });
  assert.equal(uppercase.unitDomain, "unicode");
  assert.equal(uppercase.weightDomain, "tropical-f64");
  assert.equal(uppercase.start(), 0n);
  assert.deepEqual(uppercase.state(0n), {
    valid: true,
    final: false,
    finalWeight: 0,
    arcs: [{ input: "c", output: "C", target: 1n, weight: 0 }],
  });
  assert.ok(provider.pageCalls.length > 0);
  assert.equal(provider.pageCalls.every(({ capacity }) => capacity <= 256), true);

  const dictionary = libdictenstein.dynamicDawg();
  dictionary.put("cat", 1n);
  const edit = duallity.wfst(dictionary, "cat", 0);
  const composed = llingLlang.compose(edit, uppercase);
  dictionary.close();
  edit.close();
  uppercase.close();
  uppercase.close();

  const pending = [[composed.start(), ""]];
  const seen = new Set();
  let accepted = false;
  while (pending.length > 0) {
    const [state, output] = pending.pop();
    const key = `${state}:${output}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const expanded = composed.state(state);
    if (expanded.final && output === "CAT") accepted = true;
    for (const arc of expanded.arcs) pending.push([arc.target, output + (arc.output ?? "")]);
  }
  assert.equal(accepted, true, "composition must retain the provider snapshot after source close");
  composed[Symbol.dispose]();
  assert.throws(() => composed.start(), /closed/);
  assert.doesNotThrow(() => composed[Symbol.dispose]());
});

test("native JavaScript WFST providers preserve byte and u64 label domains", () => {
  for (const [unitDomain, label] of [["byte", 255], ["u64", (1n << 63n) + 17n]]) {
    const provider = linearHostWfstProvider({ labels: [[label, label]] });
    const wfst = llingLlang.scalarWfst(provider, { unitDomain });
    try {
      const [arc] = wfst.state(0n).arcs;
      assert.equal(wfst.unitDomain, unitDomain);
      assert.equal(arc.input, label);
      assert.equal(arc.output, label);
    } finally {
      wfst.close();
    }
  }
});

test("native JavaScript WFST provider validation rejects malformed contracts", () => {
  const complete = linearHostWfstProvider();
  assert.throws(() => llingLlang.scalarWfst(null), /must be an object/);
  assert.throws(
    () => llingLlang.scalarWfst({ ...complete, stateInfo: null }),
    /stateInfo/,
  );
  assert.throws(() => llingLlang.scalarWfst(complete, null), /options must be an object/);
  assert.throws(
    () => llingLlang.scalarWfst(complete, { unitDomain: "utf16" }),
    /unknown unit domain/,
  );
  assert.throws(
    () => llingLlang.scalarWfst(complete, { weightDomain: "mystery" }),
    /unknown weight domain/,
  );
  assert.throws(() => llingLlang.scalarWfst(complete, { lazy: 1 }), /lazy must be boolean/);
  assert.throws(() => llingLlang.scalarWfst(complete, { acyclic: "yes" }), /acyclic must be boolean/);

  const cases = [
    {
      name: "number start state",
      provider: { ...complete, startState: () => 0 },
      invoke: (wfst) => wfst.start(),
    },
    {
      name: "final invalid state",
      provider: {
        ...complete,
        stateInfo: () => ({ valid: false, final: true, finalWeight: 0 }),
      },
      invoke: (wfst) => wfst.state(0n),
    },
    {
      name: "multi-scalar label",
      provider: {
        ...complete,
        stateArcs: () => [{ input: "ab", output: null, target: 1n, weight: 0 }],
      },
      invoke: (wfst) => wfst.state(0n),
    },
    {
      name: "non-bigint target",
      provider: {
        ...complete,
        stateArcs: () => [{ input: "a", output: null, target: 1, weight: 0 }],
      },
      invoke: (wfst) => wfst.state(0n),
    },
    {
      name: "NaN weight",
      provider: {
        ...complete,
        stateArcs: () => [{ input: "a", output: null, target: 1n, weight: Number.NaN }],
      },
      invoke: (wfst) => wfst.state(0n),
    },
    {
      name: "non-progressing page",
      provider: {
        ...complete,
        stateArcsPage: () => ({ arcs: [], total: 1n }),
      },
      invoke: (wfst) => wfst.state(0n),
    },
    {
      name: "inconsistent page total",
      provider: {
        ...complete,
        stateArcsPage: (_state, start, capacity) => ({
          arcs: Array.from(
            { length: start === 0n ? capacity : 1 },
            () => ({ input: "a", output: null, target: 1n, weight: 0 }),
          ),
          total: start === 0n ? 257n : 258n,
        }),
      },
      invoke: (wfst) => wfst.state(0n),
    },
  ];
  for (const { name, provider, invoke } of cases) {
    const wfst = llingLlang.scalarWfst(provider);
    try {
      assert.throws(() => invoke(wfst), Error, name);
    } finally {
      wfst.close();
    }
  }
});

test("native JavaScript WFST provider failures and reentrancy remain contained", () => {
  let throwStart = true;
  const throwing = linearHostWfstProvider();
  throwing.startState = () => {
    if (throwStart) throw new Error("provider-private failure");
    return 0n;
  };
  const recoverable = llingLlang.scalarWfst(throwing);
  assert.throws(() => recoverable.start(), /callback failed/);
  throwStart = false;
  assert.equal(recoverable.start(), 0n, "the callback gate must clear after an exception");
  recoverable.close();

  const reentrantProvider = linearHostWfstProvider();
  const plainStateInfo = reentrantProvider.stateInfo;
  let reentrant;
  reentrantProvider.stateInfo = (state) => {
    reentrant.state(state);
    return plainStateInfo(state);
  };
  reentrant = llingLlang.scalarWfst(reentrantProvider);
  assert.throws(() => reentrant.state(0n), /state_info callback failed/);
  reentrantProvider.stateInfo = plainStateInfo;
  assert.equal(reentrant.state(0n).valid, true, "reentrancy rejection must not poison the resource");
  reentrant.close();

  const selfClosingProvider = linearHostWfstProvider();
  let selfClosing;
  selfClosingProvider.startState = () => {
    selfClosing.close();
    return 0n;
  };
  selfClosing = llingLlang.scalarWfst(selfClosingProvider);
  assert.equal(selfClosing.start(), 0n, "the active callback retains its context through self-close");
  assert.throws(() => selfClosing.start(), /closed/);
});

test("native JavaScript lattice providers execute bounds, batches, laws, and ownership", () => {
  const telemetry = { joins: 0, meets: 0 };
  const low = llingLlang.lattice(
    new MaximumLatticeProvider(2, telemetry), { domainId: maximumLatticeDomain },
  );
  const middle = llingLlang.lattice(
    new MaximumLatticeProvider(5, telemetry), { domainId: maximumLatticeDomain },
  );
  const high = llingLlang.lattice(
    new MaximumLatticeProvider(9, telemetry), { domainId: maximumLatticeDomain },
  );
  const joined = low.join(middle);
  const met = middle.meet(high);
  const joinedMany = low.joinMany([middle, high]);
  const metMany = high.meetMany([middle, low]);
  try {
    assert.equal(joined.diagnostic(), "maximum(5)");
    assert.equal(met.diagnostic(), "maximum(5)");
    assert.equal(joinedMany.diagnostic(), "maximum(9)");
    assert.equal(metMany.diagnostic(), "maximum(2)");
    assert.equal(joined.equal(middle), true);
    assert.deepEqual([...high.stableBytes()], [...new TextEncoder().encode("9")]);
    assert.ok(telemetry.joins > 0);
    assert.ok(telemetry.meets > 0);
    llingLlang.validateLatticeLaws([low, middle, high]);
  } finally {
    for (const value of [joined, met, joinedMany, metMany, low, middle, high]) value.close();
  }
  assert.throws(() => low.diagnostic(), /closed/);
  assert.doesNotThrow(() => low.close());
});

test("native JavaScript semiring providers execute refined algebra and bounded batches", () => {
  const provider = new NonnegativeRealSemiring();
  const semiring = llingLlang.semiring(provider, {
    domainId: "example.real.sum",
    properties: ["hashable", "zero-sum-free", "commutative-times", "totally-ordered", "nonnegative"],
    closureBound: null,
  });
  const zero = semiring.zero();
  const one = semiring.one();
  const two = semiring.plus(one, one);
  const three = semiring.plusMany([one, two]);
  const product = semiring.timesMany([two, three]);
  const cloned = three.clone();
  const quotient = semiring.divide(product, two);
  try {
    assert.equal(semiring.equal(three, cloned), true);
    assert.equal(semiring.approximatelyEqual(three, quotient, 0), true);
    assert.equal(semiring.naturalOrder(two, three), "better");
    assert.equal(semiring.numericalValue(product), 6);
    assert.equal(semiring.quantize(three, 0.5), 6n);
    assert.equal(semiring.toProbability(three), 3);
    assert.equal(semiring.closureBound(), null);
    assert.equal(three.diagnostic(), "real(3)");
    assert.equal(semiring.diagnostic(), "nonnegative-real");
    assert.deepEqual([...three.stableBytes()], [64, 8, 0, 0, 0, 0, 0, 0]);
    assert.equal(provider.telemetry.plusMany, 1);
    assert.equal(provider.telemetry.timesMany, 1);
    semiring.validateLaws([zero, one, two, three], 0);
    assert.equal(semiring.divide(one, zero), null);
    assert.equal(semiring.star(one), null);
  } finally {
    for (const value of [quotient, cloned, product, three, two, one, zero]) value?.close();
    semiring.close();
  }
  assert.throws(() => semiring.zero(), /closed/);
});

test("native semiring context identity, hostile providers, and reentrancy are contained", () => {
  assert.throws(
    () => llingLlang.semiring({}, { domainId: "example.real.sum" }),
    /missing zero/,
  );
  const provider = new NonnegativeRealSemiring();
  const first = llingLlang.semiring(provider, { domainId: "example.real.sum" });
  const second = llingLlang.semiring(new NonnegativeRealSemiring(), {
    domainId: "example.real.sum",
  });
  const firstOne = first.one();
  const secondOne = second.one();
  assert.throws(() => first.plus(firstOne, secondOne), /different operation context/);
  const plainPlus = provider.plus.bind(provider);
  provider.plus = (left, right) => {
    first.diagnostic();
    return plainPlus(left, right);
  };
  assert.throws(() => first.plus(firstOne, firstOne), /provider|callback/i);
  provider.plus = plainPlus;
  const recovered = first.plus(firstOne, firstOne);
  try {
    assert.equal(first.numericalValue(recovered), 2);
  } finally {
    recovered.close();
    secondOne.close();
    firstOne.close();
    second.close();
    first.close();
  }
});

test("native lattice results renegotiate optional capabilities and fall back safely", () => {
  const source = new MaximumLatticeProvider(3);
  source.join = (other) => bareMaximumLattice(
    Math.max(source.value, maximumOperandValue(other)),
  );
  const left = llingLlang.lattice(source, { domainId: maximumLatticeDomain });
  const right = llingLlang.lattice(
    new MaximumLatticeProvider(7), { domainId: maximumLatticeDomain },
  );
  const downgraded = left.join(right);
  const folded = downgraded.joinMany([left, right]);
  left.close();
  right.close();
  downgraded.close();
  try {
    assert.equal(folded.diagnostic(), "maximum(7)");
    assert.throws(() => folded.stableBytes(), /does not provide stable bytes/i);
  } finally {
    folded.close();
  }
});

test("native lattice provider validation, domains, and reentrancy are contained", () => {
  assert.throws(
    () => llingLlang.lattice({}, { domainId: maximumLatticeDomain }),
    /missing join/,
  );
  assert.throws(
    () => llingLlang.lattice(new MaximumLatticeProvider(1), { domainId: "short" }),
    /exactly 16/,
  );
  const first = llingLlang.lattice(
    new MaximumLatticeProvider(1), { domainId: maximumLatticeDomain },
  );
  const foreign = llingLlang.lattice(
    new MaximumLatticeProvider(2), { domainId: "example.maximum2" },
  );
  assert.throws(() => first.join(foreign), /different runtime or domain/);

  const provider = new MaximumLatticeProvider(4);
  const plainJoin = provider.join.bind(provider);
  let reentrant;
  provider.join = (other) => {
    reentrant.diagnostic();
    return plainJoin(other);
  };
  reentrant = llingLlang.lattice(provider, { domainId: maximumLatticeDomain });
  assert.throws(() => reentrant.join(first), /callback failed|provider/i);
  provider.join = plainJoin;
  const recovered = reentrant.join(first);
  try {
    assert.equal(recovered.diagnostic(), "maximum(4)");
  } finally {
    recovered.close();
    reentrant.close();
    foreign.close();
    first.close();
  }
});
