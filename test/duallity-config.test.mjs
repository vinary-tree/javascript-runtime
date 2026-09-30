import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeDuallityConfig, decodeDuallityStatistics, encodeDuallityConfig,
} from "../duallity-config.mjs";

const limits = Object.freeze({
  maxQueryBytes: 128,
  maxQueryScalars: 32,
  maxOperationSourceScalars: 2,
  maxOperationQueryScalars: 2,
  maxRetainedDictionaryNodes: 128,
  maxRetainedWfstStates: 256,
  maxPathsPerExpansion: 128,
  maxWorkUnitsPerExpansion: 2048,
});

test("configured WFST transport round-trips limits, UTF-8, grammar and policy", () => {
  const encoded = encodeDuallityConfig({
    kind: "generalized-standard",
    maximumDistance: 2,
    cachePolicy: "lru",
    cacheCapacity: 37,
    limits,
    operations: [
      { name: "equal", consumeX: 1, consumeY: 1, weight: 0, applicability: "equal" },
      { name: "accent", consumeX: 1, consumeY: 1, weight: 0.25,
        applicability: "listed", restrictions: [{ source: "é", target: "e" }] },
    ],
  });
  assert.deepEqual(decodeDuallityConfig(encoded), {
    kind: "generalized-standard", algorithm: "standard", maximumDistance: 2,
    cachePolicy: "lru", cacheCapacity: 37, limits,
    operations: [
      { name: "equal", consumeX: 1, consumeY: 1, weight: 0,
        applicability: "equal", restrictions: [] },
      { name: "accent", consumeX: 1, consumeY: 1, weight: 0.25,
        applicability: "listed", restrictions: [{ source: "é", target: "e" }] },
    ],
  });
});

test("configuration rejects unknown fields, invalid selectors, limits and grammar", () => {
  const invalid = [
    [{ extra: true }, /unknown/],
    [{ [Symbol("hidden")]: true }, /unknown/],
    [{ kind: "missing" }, /unknown/],
    [{ cachePolicy: "all", cacheCapacity: 1 }, /only lru/],
    [{ kind: "fzf", maximumDistance: 1 }, /maximumDistance 0/],
    [{ kind: "universal-standard", maximumDistance: 256 }, /fit u8/],
    [{ kind: "levenshtein", operations: [] }, /generalized/],
    [{ kind: "generalized-standard", limits: { ...limits, maxRetainedWfstStates: 0 } }, /positive/],
    [{ kind: "generalized-standard", operations: [{
      name: "bad", consumeX: 0, consumeY: 0, weight: 1,
    }] }, /zero progress/],
    [{ kind: "generalized-standard", operations: [{
      name: "bad", consumeX: 1, consumeY: 0, weight: 0,
    }] }, /weight/],
    [{ kind: "generalized-standard", operations: [{
      name: "bad", consumeX: 1, consumeY: 1, weight: 1,
      applicability: "listed", restrictions: [{ source: "aa", target: "b" }],
    }] }, /scalar lengths/],
  ];
  for (const [options, message] of invalid) {
    assert.throws(() => encodeDuallityConfig(options), message);
  }
  const bytes = encodeDuallityConfig({});
  assert.throws(() => decodeDuallityConfig(bytes.subarray(0, 8)), /truncated/);
  const trailing = new Uint8Array(bytes.length + 1);
  trailing.set(bytes);
  assert.throws(() => decodeDuallityConfig(trailing), /trailing bytes/);
});

test("cache statistics remain lossless unsigned 64-bit counters", () => {
  const bytes = new Uint8Array(80);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 10; index += 1) {
    view.setBigUint64(index * 8, 9_007_199_254_740_992n + BigInt(index), true);
  }
  const statistics = decodeDuallityStatistics(bytes);
  assert.equal(statistics.hits, 9_007_199_254_740_992n);
  assert.equal(statistics.recencyRecords, 9_007_199_254_741_001n);
  assert.throws(() => decodeDuallityStatistics(bytes.subarray(0, 72)), /truncated/);
});
