"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { llingLlang } = require("../native.cjs");

test("CommonJS exposes JavaScript-provided scalar WFSTs", () => {
  const provider = {
    startState: () => 0n,
    stateCount: () => 1n,
    stateInfo: (state) => ({ valid: state === 0n, final: state === 0n, finalWeight: 0 }),
    stateArcs: () => [],
  };
  const wfst = llingLlang.scalarWfst(provider, { acyclic: true });
  assert.equal(wfst.start(), 0n);
  assert.deepEqual(wfst.state(0n), {
    valid: true,
    final: true,
    finalWeight: 0,
    arcs: [],
  });
  wfst.close();
});
