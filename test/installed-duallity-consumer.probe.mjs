import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const options = Object.freeze({
  kind: "generalized-standard",
  maximumDistance: 1,
  cachePolicy: "lru",
  cacheCapacity: 2,
  operations: [
    { name: "equal", consumeX: 1, consumeY: 1, weight: 0, applicability: "equal" },
    { name: "swap-a-o", consumeX: 1, consumeY: 1, weight: 1,
      applicability: "listed", restrictions: [{ source: "a", target: "o" }] },
  ],
});

function verifyHost(name, runtime, facade) {
  assert.equal(facade.runtimeIdentity, runtime.duallity.runtimeIdentity, `${name} runtime`);
  assert.equal(facade.default.configuredWfst, facade.configuredWfst, `${name} default export`);
  const dictionary = runtime.libdictenstein.dynamicDawg();
  dictionary.put("cat", 1n);
  dictionary.put("cot", 2n);
  assert.throws(() => facade.configuredWfst(dictionary, "cat", null),
    /options object/i, `${name} missing options`);
  assert.throws(() => facade.configuredWfst(dictionary, "cat", {
    ...options, unrecognizedOption: true,
  }), /unknown|unrecognized/i, `${name} unknown options`);
  assert.throws(() => facade.wfst(dictionary, "cat", 1, { cachePolicy: "none" }),
    /use configuredWfst/i, `${name} legacy constructor guard`);
  const configured = facade.configuredWfst(dictionary, "cat", options);
  const positional = facade.wfst(dictionary, "cat", 1, "standard", "levenshtein");
  dictionary.close();
  try {
    assert.equal(configured.options.kind, options.kind, `${name} kind`);
    assert.equal(configured.options.cachePolicy, "lru", `${name} cache policy`);
    assert.equal(configured.options.cacheCapacity, 2, `${name} cache capacity`);
    assert.deepEqual(configured.options.operations[1].restrictions,
      [{ source: "a", target: "o" }], `${name} operation`);
    assert.equal(configured.state(configured.start()).valid, true, `${name} configured state`);
    assert.equal(positional.state(positional.start()).valid, true, `${name} legacy state`);
    const clears = configured.cacheStatistics.clears;
    assert.equal(typeof clears, "bigint", `${name} lossless statistics`);
    assert.equal(configured.clearCache(), configured, `${name} clear chaining`);
    assert.equal(configured.cacheStatistics.clears, clears + 1n, `${name} clear count`);
    assert.equal(configured.setCachePolicy("none"), configured, `${name} policy chaining`);
    assert.equal(configured.options.cachePolicy, "none", `${name} effective policy`);
    assert.equal(configured.options.cacheCapacity, 0, `${name} effective capacity`);
    assert.equal(configured.setCachePolicy("lru", 3), configured, `${name} policy reset`);
    assert.equal(configured.options.cacheCapacity, 3, `${name} effective reset capacity`);
  } finally {
    positional.close();
    configured.close();
  }
  assert.throws(() => configured.options, /closed/i, `${name} closed owner`);
  console.log(`${name} installed configured WFST: pass`);
}

const nativeRuntime = await import("@vinary-tree/javascript-runtime");
const nativeFacade = await import("@vinary-tree/duallity");
verifyHost("native ESM", nativeRuntime, nativeFacade);
verifyHost("TypeScript entry", nativeRuntime, await import("@vinary-tree/duallity/typescript"));
verifyHost("ClojureScript entry", nativeRuntime, await import("@vinary-tree/duallity/clojurescript"));

const require = createRequire(import.meta.url);
verifyHost("native CommonJS", require("@vinary-tree/javascript-runtime"),
  require("@vinary-tree/duallity"));

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const address = input instanceof URL ? input :
    typeof input === "string" ? new URL(input) : new URL(input.url);
  if (address.protocol === "file:") {
    return new Response(await readFile(address), {
      headers: { "content-type": "application/wasm" },
    });
  }
  return originalFetch(input, init);
};
try {
  const wasmRuntime = await import("@vinary-tree/javascript-runtime/wasm");
  const wasmFacade = await import("@vinary-tree/duallity/wasm");
  verifyHost("browser WASM", wasmRuntime, wasmFacade);
  const foreign = nativeRuntime.libdictenstein.dynamicDawg();
  try {
    assert.throws(() => wasmFacade.configuredWfst(foreign, "cat", options),
      /different.*runtime/i, "cross-host dictionaries must be rejected");
  } finally {
    foreign.close();
  }
} finally {
  globalThis.fetch = originalFetch;
}

verifyHost("WASI", await import("@vinary-tree/javascript-runtime/wasi"),
  await import("@vinary-tree/duallity/wasi"));
