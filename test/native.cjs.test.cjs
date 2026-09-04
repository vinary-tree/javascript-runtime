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

test("CommonJS exposes JavaScript-provided lattice values", () => {
  const domainId = "example.maximum1";
  const maximum = (value) => ({
    value,
    join(other) { return maximum(Math.max(value, other.localValue.value)); },
    meet(other) { return maximum(Math.min(value, other.localValue.value)); },
    equal(other) { return value === other.localValue.value; },
    diagnostic() { return `maximum(${value})`; },
  });
  const left = llingLlang.lattice(maximum(2), { domainId });
  const right = llingLlang.lattice(maximum(7), { domainId });
  const joined = left.join(right);
  try {
    assert.equal(joined.diagnostic(), "maximum(7)");
  } finally {
    joined.close();
    right.close();
    left.close();
  }
});

test("CommonJS exposes JavaScript-provided semirings", () => {
  const provider = {
    zero: () => 0,
    one: () => 1,
    plus: (left, right) => left + right,
    times: (left, right) => left * right,
    equal: (left, right) => left === right,
    approximatelyEqual: (left, right, epsilon) => Math.abs(left - right) <= epsilon,
    naturalOrder: (left, right) => left < right ? "better" : left > right ? "worse" : "equal",
    diagnostic: (value) => value === undefined ? "real" : String(value),
  };
  const semiring = llingLlang.semiring(provider, { domainId: "example.real.sum" });
  const one = semiring.one();
  const two = semiring.plus(one, one);
  try {
    assert.equal(two.diagnostic(), "2");
  } finally {
    two.close();
    one.close();
    semiring.close();
  }
});
