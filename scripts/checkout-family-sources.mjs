#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readReleaseModel, sourceOwners, validateSourceRefs } from "./release-source-refs.mjs";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export function validateCheckoutParent(value) {
  const parent = resolve(value);
  if (parent !== dirname(runtimeRoot)) {
    throw new Error(`family checkout parent must be a sibling of ${runtimeRoot}; got ${parent}`);
  }
  return parent;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function selectDevelopmentRef(candidate) {
  if (typeof candidate !== "string" || !candidate.startsWith("release/")) return "master";
  const components = candidate.split("/");
  const forbidden = /[\x00-\x20\x7f~^:?*\[\\]/;
  if (
    candidate === "@"
    || candidate.startsWith("-")
    || candidate.endsWith(".")
    || candidate.includes("..")
    || candidate.includes("@{")
    || forbidden.test(candidate)
    || components.some((component) => (
      component.length === 0
      || component.startsWith(".")
      || component.startsWith("-")
      || component.endsWith(".lock")
    ))
  ) {
    throw new Error(`invalid coordinated development ref: ${candidate}`);
  }
  return candidate;
}

function developmentSourceRefs(candidate) {
  const coordinated = selectDevelopmentRef(candidate);
  return Object.freeze(Object.fromEntries(sourceOwners.map((owner) => [
    owner,
    owner === "llattice" ? "v0.1.0" : coordinated,
  ])));
}

function checkout(parent, refs, immutable) {
  for (const owner of sourceOwners) {
    const target = resolve(parent, owner);
    if (existsSync(target)) throw new Error(`refusing to reuse existing checkout ${target}`);
    run("gh", ["repo", "clone", `vinary-tree/${owner}`, target, "--", "--branch", refs[owner], "--depth", "1"]);
    run("git", ["-C", target, "diff", "--quiet"]);
    run("git", ["-C", target, "diff", "--cached", "--quiet"]);
    if (immutable) {
      const head = output("git", ["-C", target, "rev-parse", "HEAD"]);
      const tagged = output("git", ["-C", target, "rev-parse", `refs/tags/${refs[owner]}^{}`]);
      if (head !== tagged) throw new Error(`${owner} HEAD ${head} does not match ${refs[owner]} (${tagged})`);
    }
  }
}

function selfTest() {
  validateCheckoutParent(dirname(runtimeRoot));
  for (const forbidden of [runtimeRoot, resolve(runtimeRoot, "_family"), dirname(dirname(runtimeRoot))]) {
    let rejected = false;
    try {
      validateCheckoutParent(forbidden);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`unsafe checkout parent passed validation: ${forbidden}`);
  }
  if (selectDevelopmentRef(undefined) !== "master") throw new Error("missing event ref must use master");
  if (selectDevelopmentRef("feature/local") !== "master") throw new Error("feature refs must use master siblings");
  if (selectDevelopmentRef("release/4.0.0-rc.5") !== "release/4.0.0-rc.5") {
    throw new Error("coordinated release ref was not preserved");
  }
  for (const malformed of ["release/-option", "release/../escape", "release/bad ref", "release/x.lock"]) {
    let rejected = false;
    try {
      selectDevelopmentRef(malformed);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`malformed coordinated ref passed validation: ${malformed}`);
  }
  console.log("external family-checkout topology tests passed");
}

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const name = process.argv[index];
  if (name === "--development" || name === "--self-test") {
    argumentsByName.set(name, true);
    continue;
  }
  if (!name.startsWith("--") || index + 1 >= process.argv.length) throw new Error(`invalid argument: ${name}`);
  argumentsByName.set(name, process.argv[index + 1]);
  index += 1;
}

if (argumentsByName.has("--self-test")) {
  selfTest();
} else {
  const parent = validateCheckoutParent(argumentsByName.get("--parent") ?? dirname(runtimeRoot));
  const development = argumentsByName.has("--development");
  const refs = development
    ? developmentSourceRefs(argumentsByName.get("--development-ref"))
    : validateSourceRefs(readReleaseModel());
  checkout(parent, refs, !development);
}
