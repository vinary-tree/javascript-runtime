import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { libdictenstein, duallity } from "@vinary-tree/javascript-runtime";
import { createWasiRuntime } from "@vinary-tree/javascript-runtime/wasi";

function exercise(runtime) {
  const dictionary = runtime.libdictenstein.dynamicDawg();
  dictionary.put("café", 1n);
  const wfst = runtime.duallity.configuredWfst(dictionary, "café", {
    maximumDistance: 0, cachePolicy: "lru", cacheCapacity: 2,
  });
  try {
    assert.equal(wfst.options.cacheCapacity, 2);
    assert.equal(typeof wfst.cacheStatistics.misses, "bigint");
    wfst.setCachePolicy("none");
    assert.equal(wfst.options.cachePolicy, "none");
  } finally {
    wfst.close();
    dictionary.close();
  }
}

exercise({ libdictenstein, duallity });
const require = createRequire(import.meta.url);
exercise(require("@vinary-tree/javascript-runtime"));
exercise(await createWasiRuntime({ preopens: {} }));

// A browser bundler normally initializes this route. In Node, initialize the
// exact installed bytes explicitly so the probe needs no network/file fetch.
const packageUrl = import.meta.resolve("@vinary-tree/javascript-runtime/wasm");
const raw = await import(new URL("./generated/wasm/vinary_tree.js", packageUrl));
const { createRuntime } = await import(new URL("./runtime-factory.mjs", packageUrl));
raw.initSync({ module: readFileSync(new URL("./generated/wasm/vinary_tree_bg.wasm", packageUrl)) });
exercise(createRuntime(raw));

console.log("installed native ESM, CommonJS, browser-WASM, and WASI config bridges passed");
