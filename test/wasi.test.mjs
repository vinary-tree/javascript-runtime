import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createWasiRuntime } from "../wasi-runtime.mjs";

function values(cursor) {
  try { return [...cursor].map(({ term, id }) => [term.value, id]); }
  finally { cursor.close(); }
}

test("WASI persistent ARTrie checkpoints, reopens, and retains query snapshots", async () => {
  const scratch = fileURLToPath(new URL("../.build/wasi-tests", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "persistent-artrie-"));
  try {
    const runtime = await createWasiRuntime({ preopens: { "/data": directory } });
    let dictionary = runtime.libdictenstein.createPersistentARTrie("/data/words.artrie");
    for (const [term, id] of [["cat", 1n], ["cot", 2n], ["cut", null]]) dictionary.put(term, id);
    dictionary.checkpoint();

    const transducer = runtime.liblevenshtein.transducer(dictionary);
    const cursor = transducer.query("cat", 2, "distance-then-term");
    const first = cursor.next().value;
    dictionary.remove("cot");
    dictionary.put("cit", 4n);
    dictionary.checkpoint();
    assert.deepEqual(
      [first, ...cursor].map(({ term, id }) => [term.value, id]),
      [["cat", 1n], ["cot", 2n], ["cut", null]],
    );
    cursor.close();
    dictionary.close();
    assert.deepEqual(values(transducer.query("cat", 2, "distance-then-term")), [
      ["cat", 1n], ["cit", 4n], ["cut", null],
    ]);
    transducer.close();

    dictionary = runtime.libdictenstein.openPersistentARTrie("/data/words.artrie");
    assert.deepEqual(dictionary.lookup("cit"), { found: true, value: 4n });
    assert.deepEqual(dictionary.lookup("cot"), { found: false, value: null });
    dictionary.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WASI dictionaries expose closeable snapshot collection iterators", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  const dictionary = runtime.libdictenstein.dynamicDawg();
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

  const bytes = runtime.libdictenstein.dynamicDawg("byte");
  bytes.set(new Uint8Array([0, 255]), 4n);
  const [[byteKey, byteValue]] = [...bytes];
  assert.deepEqual([...byteKey], [0, 255]);
  assert.equal(byteValue, 4n);
  bytes.close();

  const tokens = runtime.libdictenstein.dynamicDawg("u64");
  tokens.set(new BigUint64Array([0n, 2n ** 63n]), null);
  assert.equal(tokens.has(new BigUint64Array([0n, 2n ** 63n])), true);
  const [[tokenKey, tokenValue]] = [...tokens];
  assert.deepEqual([...tokenKey], [0n, 2n ** 63n]);
  assert.equal(tokenValue, null);
  tokens.close();
});

test("WASI dictionary algebra delegates snapshot set operations", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  const left = runtime.libdictenstein.dynamicDawg();
  left.set("cat", 3n).set("dog", null);
  const right = runtime.libdictenstein.dynamicDawg();
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

test("WASI dynamic cursor survives remove, update, clear, and compact", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  for (let trace = 0; trace < 32; trace += 1) {
    const dictionary = runtime.libdictenstein.dynamicDawg();
    for (let index = 0; index < 12; index += 1) dictionary.put(`t${trace}-${index}`, BigInt(index));
    const transducer = runtime.liblevenshtein.transducer(dictionary);
    const expected = values(transducer.query("", 32, "distance-then-term"));
    const cursor = transducer.query("", 32, "distance-then-term");
    const actual = [cursor.next().value];
    dictionary.remove(`t${trace}-1`);
    dictionary.put(`t${trace}-2`, 99n);
    actual.push(cursor.next().value);
    dictionary.clear();
    dictionary.compact();
    dictionary.put(`after-${trace}`, 100n);
    actual.push(...cursor);
    assert.deepEqual(actual.map(({ term, id }) => [term.value, id]), expected, `trace ${trace}`);
    cursor.close();
    transducer.close();
    dictionary.close();
  }
});

test("WASI reducer and iterator drain a query to the same matches (C5)", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  const dictionary = runtime.libdictenstein.dynamicDawg();
  for (const [term, id] of [["cat", 1n], ["cot", 2n], ["cut", 3n]]) dictionary.put(term, id);
  const transducer = runtime.liblevenshtein.transducer(dictionary);
  try {
    const byIterator = values(transducer.query("cat", 1))
      .map(([value, id]) => `${value}:${id}`)
      .sort();
    const reducerCursor = transducer.query("cat", 1);
    const byReducer = reducerCursor
      .reduceBatches((accumulator, batch) => {
        for (const { term, id } of batch) accumulator.push(`${term.value}:${id}`);
        return accumulator;
      }, [])
      .sort();
    reducerCursor.close();
    assert.deepEqual(byIterator, byReducer);
    assert.equal(byIterator.length, 3);
  } finally {
    transducer.close();
    dictionary.close();
  }
});

test("WASI exposes lock-safe bounded cache hits and exact revision invalidation", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  const dictionary = runtime.libdictenstein.dynamicDawg();
  dictionary.set("cat", 1n).set("cot", 2n);
  const transducer = runtime.liblevenshtein.transducer(dictionary);
  const cache = runtime.liblevenshtein.queryCache(transducer, {
    maximumEntries: 4,
    maximumWeight: 4096,
  });
  assert.deepEqual(values(cache.query("cat", 1, "distance-then-term")), [
    ["cat", 1n], ["cot", 2n],
  ]);
  values(cache.query("cat", 1, "distance-then-term"));
  assert.equal(cache.stats.hits, 1n);
  dictionary.delete("cot");
  transducer.close();
  dictionary.close();
  assert.deepEqual(values(cache.query("cat", 1, "distance-then-term")), [["cat", 1n]]);
  cache.clear().resetStats();
  assert.equal(cache.stats.residentEntries, 0);
  assert.equal(cache.stats.requests, 0n);
  cache.close();

  const bytes = runtime.libdictenstein.dynamicDawg("byte");
  bytes.set(new Uint8Array([99, 97, 116]), 3n);
  const byteTransducer = runtime.liblevenshtein.transducer(bytes);
  assert.deepEqual(values(byteTransducer.query(new Uint8Array([99, 117, 116]), 1)), [
    [new Uint8Array([99, 97, 116]), 3n],
  ]);
  const byteCache = runtime.liblevenshtein.queryCache(byteTransducer);
  assert.deepEqual(values(byteCache.query(new Uint8Array([99, 117, 116]), 1)), [
    [new Uint8Array([99, 97, 116]), 3n],
  ]);
  byteCache.close();
  byteTransducer.close();
  bytes.close();

  const tokens = runtime.libdictenstein.dynamicDawg("u64");
  tokens.set(new BigUint64Array([1n, 2n]), 4n);
  const tokenTransducer = runtime.liblevenshtein.transducer(tokens);
  assert.deepEqual(values(tokenTransducer.query(new BigUint64Array([1n, 3n]), 1)), [
    [new BigUint64Array([1n, 2n]), 4n],
  ]);
  const tokenCache = runtime.liblevenshtein.queryCache(tokenTransducer);
  assert.deepEqual(values(tokenCache.query(new BigUint64Array([1n, 3n]), 1)), [
    [new BigUint64Array([1n, 2n]), 4n],
  ]);
  tokenCache.close();
  tokenTransducer.close();
  tokens.close();
});

test("WASI duallity snapshots compose with lling-llang in the same instance", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  const dictionary = runtime.libdictenstein.dynamicDawg();
  dictionary.put("cat", 1n);
  const edit = runtime.duallity.wfst(dictionary, "cat", 1);
  dictionary.clear();
  dictionary.close();

  const builder = runtime.llingLlang.vectorWfst();
  const states = [builder.addState(), builder.addState(), builder.addState(), builder.addState()];
  builder.setStart(states[0]);
  builder.setFinal(states[3], 0);
  for (const [index, [input, output]] of [["c", "C"], ["a", "A"], ["t", "T"]].entries()) {
    builder.addArc(states[index], input, output, states[index + 1], 0);
  }
  const uppercase = builder.build();
  const composed = runtime.llingLlang.compose(edit, uppercase);
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

test("WASI host WFST providers page, compose, retain, and dispose", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  const provider = linearHostWfstProvider({ paged: true });
  const uppercase = runtime.llingLlang.scalarWfst(provider, {
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

  const dictionary = runtime.libdictenstein.dynamicDawg();
  dictionary.put("cat", 1n);
  const edit = runtime.duallity.wfst(dictionary, "cat", 0);
  const composed = runtime.llingLlang.compose(edit, uppercase);
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

test("WASI host WFST providers preserve byte and u64 labels", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  for (const [unitDomain, label] of [["byte", 255], ["u64", (1n << 63n) + 17n]]) {
    const wfst = runtime.llingLlang.scalarWfst(
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

test("WASI host WFST providers contain malformed, throwing, and reentrant callbacks", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  const complete = linearHostWfstProvider();
  assert.throws(() => runtime.llingLlang.scalarWfst(null), /must be an object/);
  assert.throws(
    () => runtime.llingLlang.scalarWfst({ ...complete, stateInfo: null }),
    /stateInfo/,
  );
  assert.throws(() => runtime.llingLlang.scalarWfst(complete, null), /options must be an object/);
  assert.throws(
    () => runtime.llingLlang.scalarWfst(complete, { unitDomain: "utf16" }),
    /unknown unit domain/,
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
    const wfst = runtime.llingLlang.scalarWfst(provider);
    try {
      assert.throws(() => invoke(wfst), Error);
    } finally {
      wfst.close();
    }
  }

  let throwStart = true;
  const throwing = linearHostWfstProvider();
  throwing.startState = () => {
    if (throwStart) throw new Error("provider-private failure");
    return 0n;
  };
  const recoverable = runtime.llingLlang.scalarWfst(throwing);
  assert.throws(() => recoverable.start(), /ProviderError/);
  throwStart = false;
  assert.equal(recoverable.start(), 0n);
  recoverable.close();

  const reentrantProvider = linearHostWfstProvider();
  const plainStateInfo = reentrantProvider.stateInfo;
  let reentrant;
  reentrantProvider.stateInfo = (state) => {
    reentrant.state(state);
    return plainStateInfo(state);
  };
  reentrant = runtime.llingLlang.scalarWfst(reentrantProvider);
  assert.throws(() => reentrant.state(0n), /ProviderError/);
  reentrantProvider.stateInfo = plainStateInfo;
  assert.equal(reentrant.state(0n).valid, true, "reentrancy rejection must not poison the handle");
  reentrant.close();

  const selfClosingProvider = linearHostWfstProvider();
  let selfClosing;
  selfClosingProvider.startState = () => {
    selfClosing.close();
    return 0n;
  };
  selfClosing = runtime.llingLlang.scalarWfst(selfClosingProvider);
  assert.equal(selfClosing.start(), 0n, "the active guest capture must outlive source close");
  assert.throws(() => selfClosing.start(), /closed/);
});

test("WASI host provider generations cannot alias recycled slots", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  let retiredCalls = 0;
  const retired = linearHostWfstProvider({ labels: [["x", "x"]] });
  const retiredState = retired.stateInfo;
  retired.stateInfo = (state) => {
    retiredCalls += 1;
    return retiredState(state);
  };
  const oldWfst = runtime.llingLlang.scalarWfst(retired);
  oldWfst.close();
  for (let index = 0; index < 4096; index += 1) {
    const current = runtime.llingLlang.scalarWfst(linearHostWfstProvider({ labels: [["y", "y"]] }));
    assert.equal(current.state(0n).arcs[0].input, "y");
    current.close();
  }
  assert.equal(retiredCalls, 0, "recycled generational handles must never dispatch to retired providers");
});

const wasiLatticeDomain = "example.maximum1";

function wasiMaximumOperand(operand) {
  if (operand.domainId !== wasiLatticeDomain ||
      operand.localValue === null || typeof operand.localValue.value !== "number") {
    throw new TypeError("foreign maximum lattice value");
  }
  return operand.localValue.value;
}

function wasiBareMaximum(value) {
  return {
    value,
    join(other) { return wasiBareMaximum(Math.max(value, wasiMaximumOperand(other))); },
    meet(other) { return wasiBareMaximum(Math.min(value, wasiMaximumOperand(other))); },
    equal(other) { return value === wasiMaximumOperand(other); },
    diagnostic() { return `maximum(${value})`; },
  };
}

class WasiMaximum {
  constructor(value, calls = { batches: 0 }) {
    this.value = value;
    this.calls = calls;
  }
  join(other) {
    return new WasiMaximum(Math.max(this.value, wasiMaximumOperand(other)), this.calls);
  }
  meet(other) {
    return new WasiMaximum(Math.min(this.value, wasiMaximumOperand(other)), this.calls);
  }
  equal(other) { return this.value === wasiMaximumOperand(other); }
  diagnostic() { return `maximum(${this.value})`; }
  stableBytes() { return new TextEncoder().encode(String(this.value)); }
  joinMany(others) {
    this.calls.batches += 1;
    return new WasiMaximum(
      Math.max(this.value, ...others.map(wasiMaximumOperand)), this.calls,
    );
  }
  meetMany(others) {
    this.calls.batches += 1;
    return new WasiMaximum(
      Math.min(this.value, ...others.map(wasiMaximumOperand)), this.calls,
    );
  }
}

test("WASI lattice providers execute bounds, batches, laws, and disposal", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  const calls = { batches: 0 };
  const low = runtime.llingLlang.lattice(
    new WasiMaximum(2, calls), { domainId: wasiLatticeDomain },
  );
  const middle = runtime.llingLlang.lattice(
    new WasiMaximum(5, calls), { domainId: wasiLatticeDomain },
  );
  const high = runtime.llingLlang.lattice(
    new WasiMaximum(9, calls), { domainId: wasiLatticeDomain },
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
    assert.ok(calls.batches >= 2);
    runtime.llingLlang.validateLatticeLaws([low, middle, high]);
  } finally {
    for (const value of [joined, met, joinedMany, metMany, low, middle, high]) value.close();
  }
  assert.throws(() => low.diagnostic(), /closed/);
  assert.doesNotThrow(() => low.close());
});

test("WASI lattice results renegotiate capabilities and outlive their sources", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  const source = new WasiMaximum(3);
  source.join = (other) => wasiBareMaximum(
    Math.max(source.value, wasiMaximumOperand(other)),
  );
  const left = runtime.llingLlang.lattice(source, { domainId: wasiLatticeDomain });
  const right = runtime.llingLlang.lattice(
    new WasiMaximum(7), { domainId: wasiLatticeDomain },
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

test("WASI lattice providers reject malformed, foreign-domain, and reentrant calls", async () => {
  const runtime = await createWasiRuntime({ preopens: {} });
  assert.throws(() => runtime.llingLlang.lattice({}, { domainId: wasiLatticeDomain }), /missing join/);
  assert.throws(
    () => runtime.llingLlang.lattice(new WasiMaximum(1), { domainId: "short" }),
    /16 printable/,
  );
  const local = runtime.llingLlang.lattice(
    new WasiMaximum(1), { domainId: wasiLatticeDomain },
  );
  const foreign = runtime.llingLlang.lattice(
    new WasiMaximum(2), { domainId: "example.maximum2" },
  );
  assert.throws(() => local.join(foreign), /different semantic domain/);
  assert.throws(() => runtime.llingLlang.validateLatticeLaws([]), /one through sixteen/);
  foreign.close();

  const provider = new WasiMaximum(4);
  const plainJoin = provider.join.bind(provider);
  let reentrant;
  provider.join = (other) => {
    reentrant.diagnostic();
    return plainJoin(other);
  };
  reentrant = runtime.llingLlang.lattice(provider, { domainId: wasiLatticeDomain });
  assert.throws(() => reentrant.join(local), /ProviderError/);
  provider.join = plainJoin;
  const recovered = reentrant.join(local);
  try {
    assert.equal(recovered.diagnostic(), "maximum(4)");
  } finally {
    recovered.close();
    reentrant.close();
    local.close();
  }
});
