import assert from "node:assert/strict";

const limits = Object.freeze({
  maxQueryBytes: 1024,
  maxQueryScalars: 256,
  maxOperationSourceScalars: 4,
  maxOperationQueryScalars: 4,
  maxRetainedDictionaryNodes: 1024,
  maxRetainedWfstStates: 1024,
  maxPathsPerExpansion: 1024,
  maxWorkUnitsPerExpansion: 8192,
});

/** The same native read-back and control contract must hold in all hosts. */
export function verifyConfiguredDuallity({ libdictenstein, duallity, llingLlang }) {
  const dictionary = libdictenstein.dynamicDawg();
  dictionary.put("cat", 1n);
  dictionary.put("cot", 2n);
  const configured = duallity.configuredWfst(dictionary, "cat", {
    kind: "generalized-standard",
    maximumDistance: 1,
    cachePolicy: "lru",
    cacheCapacity: 2,
    limits,
    operations: [
      { name: "equal", consumeX: 1, consumeY: 1, weight: 0, applicability: "equal" },
      { name: "swap-a-o", consumeX: 1, consumeY: 1, weight: 1,
        applicability: "listed", restrictions: [{ source: "a", target: "o" }] },
    ],
  });
  dictionary.clear();
  dictionary.close();
  try {
    const options = configured.options;
    assert.equal(options.kind, "generalized-standard");
    assert.equal(options.maximumDistance, 1);
    assert.equal(options.cachePolicy, "lru");
    assert.equal(options.cacheCapacity, 2);
    assert.deepEqual(options.limits, limits);
    assert.equal(options.operations.length, 2);
    assert.deepEqual(options.operations[1].restrictions, [{ source: "a", target: "o" }]);

    const start = configured.start();
    assert.equal(configured.state(start).valid, true);
    assert.equal(typeof configured.cacheStatistics.misses, "bigint");
    assert.ok(configured.cacheStatistics.misses >= 1n);
    const before = configured.cacheStatistics.clears;
    assert.equal(configured.clearCache(), configured);
    assert.equal(configured.cacheStatistics.clears, before + 1n);
    assert.equal(configured.cacheStatistics.residentStates, 0n);
    assert.equal(configured.setCachePolicy("none"), configured);
    assert.equal(configured.options.cachePolicy, "none");
    assert.equal(configured.options.cacheCapacity, 0);
    assert.throws(() => configured.setCachePolicy("all", 1), /capacity|policy/i);
    assert.equal(configured.setCachePolicy("lru", 3), configured);
    assert.equal(configured.options.cacheCapacity, 3);

    const builder = llingLlang.vectorWfst();
    const state = builder.addState();
    builder.setStart(state);
    builder.setFinal(state, 0);
    const identity = builder.build();
    builder.close();
    const composed = llingLlang.compose(configured, identity);
    identity.close();
    assert.equal(typeof composed.start(), "bigint");
    assert.throws(() => composed.options, /owner|configuration/i);
    composed.close();
  } finally {
    configured.close();
  }
  assert.throws(() => configured.options, /closed/i);

  const other = libdictenstein.dynamicDawg();
  const legacy = duallity.wfst(other, "cat", 0);
  try {
    assert.throws(() => legacy.cacheStatistics, /owner|configuration/i);
  } finally {
    legacy.close();
    other.close();
  }

  const fzfDictionary = libdictenstein.dynamicDawg();
  fzfDictionary.put("cat", 1n);
  const fzf = duallity.configuredWfst(fzfDictionary, "cat", {
    kind: "fzf", maximumDistance: 0, cachePolicy: "lru", cacheCapacity: 0,
  });
  try {
    assert.equal(fzf.weightDomain, "arctic-f64");
    assert.equal(fzf.options.cachePolicy, "none");
    assert.equal(fzf.options.cacheCapacity, 0);
  } finally {
    fzf.close();
    fzfDictionary.close();
  }
}
