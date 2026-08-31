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

export function validateDevelopmentRef(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return "master";
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

function remoteBranchExists(owner, candidate) {
  const result = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--heads", `https://github.com/vinary-tree/${owner}.git`, candidate],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 2) return false;
  throw new Error(`could not resolve ${owner} development ref ${candidate}: ${result.stderr}`);
}

export function developmentSourceRefs(candidate, branchExists = remoteBranchExists) {
  const coordinated = validateDevelopmentRef(candidate);
  const releaseTrain = coordinated.startsWith("release/");
  const baseline = (owner) => (owner === "llattice" ? "v0.1.0" : "master");
  return Object.freeze(Object.fromEntries(sourceOwners.map((owner) => {
    if (releaseTrain) return [owner, owner === "llattice" ? baseline(owner) : coordinated];
    if (coordinated !== "master" && branchExists(owner, coordinated)) {
      return [owner, coordinated];
    }
    return [owner, baseline(owner)];
  })));
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
  if (validateDevelopmentRef(undefined) !== "master") throw new Error("missing event ref must use master");
  if (validateDevelopmentRef("feature/local") !== "feature/local") {
    throw new Error("valid feature ref was not preserved");
  }
  if (validateDevelopmentRef("release/4.0.0-rc.5") !== "release/4.0.0-rc.5") {
    throw new Error("coordinated release ref was not preserved");
  }
  const featureRefs = developmentSourceRefs(
    "feature/local",
    (owner) => owner === "duallity" || owner === "llattice",
  );
  if (featureRefs.duallity !== "feature/local" || featureRefs.llattice !== "feature/local") {
    throw new Error("available family feature branches were not selected");
  }
  if (featureRefs.libdictenstein !== "master") {
    throw new Error("missing family feature branch did not fall back to master");
  }
  const baselineRefs = developmentSourceRefs(undefined, () => {
    throw new Error("baseline selection must not query feature branches");
  });
  if (baselineRefs.llattice !== "v0.1.0" || baselineRefs.duallity !== "master") {
    throw new Error("baseline family refs were not selected");
  }
  for (const malformed of ["-option", "feature/../escape", "feature/bad ref", "feature/x.lock"]) {
    let rejected = false;
    try {
      validateDevelopmentRef(malformed);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`malformed coordinated ref passed validation: ${malformed}`);
  }
  console.log("external family-checkout topology tests passed");
}

function main() {
  const argumentsByName = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const name = process.argv[index];
    if (name === "--development" || name === "--self-test") {
      argumentsByName.set(name, true);
      continue;
    }
    if (!name.startsWith("--") || index + 1 >= process.argv.length) {
      throw new Error(`invalid argument: ${name}`);
    }
    argumentsByName.set(name, process.argv[index + 1]);
    index += 1;
  }
  if (argumentsByName.has("--self-test")) {
    selfTest();
    return;
  }
  const parent = validateCheckoutParent(argumentsByName.get("--parent") ?? dirname(runtimeRoot));
  const development = argumentsByName.has("--development");
  const refs = development
    ? developmentSourceRefs(argumentsByName.get("--development-ref"))
    : validateSourceRefs(readReleaseModel());
  checkout(parent, refs, !development);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
