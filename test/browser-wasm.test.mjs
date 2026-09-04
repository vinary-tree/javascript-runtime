import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as raw from "../generated/wasm/vinary_tree.js";
import { createRuntime } from "../runtime-factory.mjs";

raw.initSync({
  module: await readFile(new URL("../generated/wasm/vinary_tree_bg.wasm", import.meta.url)),
});
const { libdictenstein, liblevenshtein, llingLlang, duallity, runtimeIdentity } = createRuntime(raw);

function collect(cursor) {
  try {
    return [...cursor].map(({ term, distance, id }) => ({
      term: term.value,
      distance,
      id,
    }));
  } finally {
    cursor.close();
  }
}

test("all namespaces share one identity and transfer dictionaries in O(1)", () => {
  assert.equal(libdictenstein.runtimeIdentity, runtimeIdentity);
  assert.equal(liblevenshtein.runtimeIdentity, runtimeIdentity);
  const dictionary = libdictenstein.dynamicDawg();
  dictionary.put("kitten", 7n);
  dictionary.put("sitting", null);
  const transducer = liblevenshtein.transducer(dictionary);
  assert.deepEqual(collect(transducer.query("kitten", 3, "distance-then-term")), [
    { term: "kitten", distance: 0, id: 7n },
    { term: "sitting", distance: 3, id: null },
  ]);
  assert.equal(liblevenshtein.levenshteinDistance("kitten", "sitting"), 3);
  transducer.close();
  dictionary.close();
});

test("one long-lived iterator has exact query-start snapshot semantics", () => {
  let state = 0x9e3779b9;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (let trace = 0; trace < 64; trace += 1) {
    const dictionary = libdictenstein.dynamicDawg();
    const terms = new Set();
    while (terms.size < 16) terms.add(`t${trace}-${random().toString(36)}`);
    let id = 0n;
    for (const term of terms) dictionary.put(term, id++);
    const transducer = liblevenshtein.transducer(dictionary);
    const expected = collect(transducer.query("", 64, "distance-then-term"));
    const cursor = transducer.query("", 64, "distance-then-term");
    const actual = [];

    actual.push(cursor.next().value);
    const first = terms.values().next().value;
    dictionary.remove(first);
    dictionary.put(first, 999n);
    actual.push(cursor.next().value);
    dictionary.clear();
    dictionary.compact();
    actual.push(cursor.next().value);
    dictionary.put(`after-${trace}`, 1000n);
    for (const match of cursor) actual.push(match);

    assert.deepEqual(
      actual.map(({ term, distance, id: matchId }) => ({ term: term.value, distance, id: matchId })),
      expected,
      `trace ${trace}`,
    );
    assert.deepEqual(
      collect(transducer.query("", 64, "distance-then-term")).map(({ term }) => term),
      [`after-${trace}`],
    );
    cursor.close();
    transducer.close();
    dictionary.close();
  }
});

test("u64 dictionaries and batch reduction remain streaming", () => {
  const dictionary = libdictenstein.dynamicDawg("u64");
  dictionary.putU64(new BigUint64Array([1n, 2n]), 8n);
  assert.deepEqual(dictionary.lookupU64(new BigUint64Array([1n, 2n])), { found: true, value: 8n });
  const transducer = liblevenshtein.transducer(dictionary);
  const count = transducer
    .query(new BigUint64Array([1n, 3n]), 1)
    .reduceBatches((sum, batch) => sum + batch.length, 0, 1);
  assert.equal(count, 1);
  transducer.close();
  dictionary.close();
});

test("browser-WASM exposes exact bounded cache hits and revision invalidation", () => {
  const dictionary = libdictenstein.dynamicDawg();
  dictionary.set("cat", 1n).set("cot", 2n);
  const transducer = liblevenshtein.transducer(dictionary);
  const cache = liblevenshtein.queryCache(transducer, {
    maximumEntries: 4,
    maximumWeight: 4096,
  });
  assert.deepEqual(collect(cache.query("cat", 1, "distance-then-term")), [
    { term: "cat", distance: 0, id: 1n },
    { term: "cot", distance: 1, id: 2n },
  ]);
  collect(cache.query("cat", 1, "distance-then-term"));
  assert.equal(cache.stats.hits, 1n);
  dictionary.delete("cot");
  transducer.close();
  dictionary.close();
  assert.deepEqual(collect(cache.query("cat", 1, "distance-then-term")), [
    { term: "cat", distance: 0, id: 1n },
  ]);
  cache.clear().resetStats();
  assert.equal(cache.stats.residentEntries, 0);
  assert.equal(cache.stats.requests, 0n);
  cache.close();

  const bytes = libdictenstein.dynamicDawg("byte");
  bytes.set(new Uint8Array([99, 97, 116]), 3n);
  const byteTransducer = liblevenshtein.transducer(bytes);
  const byteCache = liblevenshtein.queryCache(byteTransducer);
  assert.deepEqual(collect(byteCache.query(new Uint8Array([99, 117, 116]), 1)), [
    { term: new Uint8Array([99, 97, 116]), distance: 1, id: 3n },
  ]);
  assert.throws(
    () => byteCache.query(new Uint8Array([99, 117, 116]), 1, "distance-then-term"),
    /ordered streaming is unsupported for Byte/,
  );
  byteCache.close();
  byteTransducer.close();
  bytes.close();

  const tokens = libdictenstein.dynamicDawg("u64");
  tokens.set(new BigUint64Array([1n, 2n]), 4n);
  const tokenTransducer = liblevenshtein.transducer(tokens);
  const tokenCache = liblevenshtein.queryCache(tokenTransducer);
  assert.deepEqual(collect(tokenCache.query(new BigUint64Array([1n, 3n]), 1)), [
    { term: new BigUint64Array([1n, 2n]), distance: 1, id: 4n },
  ]);
  tokenCache.close();
  tokenTransducer.close();
  tokens.close();
});

test("browser dictionaries expose host-owned Map collection snapshots", () => {
  const dictionary = libdictenstein.dynamicDawg();
  dictionary.set("cat", 1n).set("caff", null).set("dog", 3n);
  assert.equal(dictionary.get("cat"), 1n);
  assert.equal(dictionary.get("caff"), null);
  assert.equal(dictionary.get("absent"), undefined);

  const entries = dictionary.entries();
  const cursor = dictionary.streamEntries();
  assert.equal(cursor.size, 3);
  dictionary.delete("cat");
  dictionary.set("zebra", 9n);
  assert.deepEqual([...entries], [["caff", null], ["cat", 1n], ["dog", 3n]]);
  assert.deepEqual([...cursor], [["caff", null], ["cat", 1n], ["dog", 3n]]);
  assert.equal(Object.isFrozen(dictionary.snapshotEntries()), true);
  assert.deepEqual([...dictionary.keys()], ["caff", "dog", "zebra"]);
  assert.deepEqual([...dictionary.values()], [null, 3n, 9n]);
  assert.deepEqual([...dictionary.toMap()], [...dictionary]);
  dictionary.close();

  const bytes = libdictenstein.dynamicDawg("byte");
  bytes.set(new Uint8Array([0, 255]), 4n);
  const [[byteKey, byteValue]] = [...bytes];
  assert.deepEqual([...byteKey], [0, 255]);
  assert.equal(byteValue, 4n);
  bytes.close();

  const tokens = libdictenstein.dynamicDawg("u64");
  tokens.set(new BigUint64Array([0n, 2n ** 63n]), null);
  const [[tokenKey, tokenValue]] = [...tokens];
  assert.deepEqual([...tokenKey], [0n, 2n ** 63n]);
  assert.equal(tokenValue, null);
  tokens.close();
});

test("browser dictionary algebra delegates snapshot set operations", () => {
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

test("duallity WFST composes lazily with a lling-llang VectorWfst", () => {
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
      return { arcs: arcs.slice(first, first + capacity), total: BigInt(arcs.length) };
    };
    provider.stateArcs = () => {
      throw new Error("paged providers must not materialize their complete arc list");
    };
  }
  return provider;
}

test("browser JavaScript WFST providers page, compose, retain, and dispose", () => {
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
  assert.equal(accepted, true, "composition must retain the provider after its source closes");
  composed[Symbol.dispose]();
  assert.throws(() => composed.start(), /closed/);
  assert.doesNotThrow(() => composed[Symbol.dispose]());
});

test("browser JavaScript WFST providers preserve scalar label domains", () => {
  for (const [unitDomain, label] of [["byte", 255], ["u64", (1n << 63n) + 17n]]) {
    const wfst = llingLlang.scalarWfst(
      linearHostWfstProvider({ labels: [[label, label]] }),
      { unitDomain },
    );
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

test("browser JavaScript WFST providers do not expand invalid states", () => {
  const provider = linearHostWfstProvider();
  let arcCalls = 0;
  provider.stateArcs = (state) => {
    arcCalls += 1;
    if (state === 99n) throw new Error("invalid states must not request arcs");
    return [];
  };
  const wfst = llingLlang.scalarWfst(provider);
  try {
    assert.deepEqual(wfst.state(99n), {
      valid: false,
      final: false,
      finalWeight: 0,
      arcs: [],
    });
    assert.equal(arcCalls, 0);
  } finally {
    wfst.close();
  }
});

test("browser JavaScript WFST providers reject malformed and reentrant callbacks", () => {
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

  const malformed = [
    [{ ...complete, startState: () => 0 }, (wfst) => wfst.start()],
    [{
      ...complete,
      stateInfo: () => ({ valid: false, final: true, finalWeight: 0 }),
    }, (wfst) => wfst.state(0n)],
    [{
      ...complete,
      stateArcs: () => [{ input: "ab", output: null, target: 1n, weight: 0 }],
    }, (wfst) => wfst.state(0n)],
    [{
      ...complete,
      stateArcsPage: () => ({ arcs: [], total: 1n }),
    }, (wfst) => wfst.state(0n)],
    [{
      ...complete,
      stateArcsPage: (_state, start, capacity) => ({
        arcs: Array.from(
          { length: start === 0n ? capacity : 1 },
          () => ({ input: "a", output: null, target: 1n, weight: 0 }),
        ),
        total: start === 0n ? 257n : 258n,
      }),
    }, (wfst) => wfst.state(0n)],
  ];
  for (const [provider, invoke] of malformed) {
    const wfst = llingLlang.scalarWfst(provider);
    try {
      assert.throws(() => invoke(wfst), Error);
    } finally {
      wfst.close();
    }
  }

  const reentrantProvider = linearHostWfstProvider();
  const plainStateInfo = reentrantProvider.stateInfo;
  let reentrant;
  reentrantProvider.stateInfo = (state) => {
    reentrant.state(state);
    return plainStateInfo(state);
  };
  reentrant = llingLlang.scalarWfst(reentrantProvider);
  assert.throws(() => reentrant.state(0n), /ProviderError/);
  reentrantProvider.stateInfo = plainStateInfo;
  assert.equal(reentrant.state(0n).valid, true);
  reentrant.close();

  const selfClosingProvider = linearHostWfstProvider();
  let selfClosing;
  selfClosingProvider.startState = () => {
    selfClosing.close();
    return 0n;
  };
  selfClosing = llingLlang.scalarWfst(selfClosingProvider);
  assert.throws(() => selfClosing.start(), /ProviderError/);
  selfClosingProvider.startState = () => 0n;
  assert.equal(selfClosing.start(), 0n, "a rejected self-close must not poison the resource");
  selfClosing.close();
});
