#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const model = JSON.parse(readFileSync(join(root, "release", "version.json"), "utf8"));
const registries = new Set(["validate-only", "npm"]);

function validate(ref, refName, registry) {
  if (!registries.has(registry)) throw new Error(`unknown release registry: ${registry}`);
  if (ref !== `refs/tags/${refName}`) {
    throw new Error("manual releases must target an immutable tag");
  }
  const canonical = `v${model.canonical}`;
  if (refName === canonical) return;
  const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^${escaped}-release\\.[1-9][0-9]*$`).test(refName)) return;
  throw new Error(
    `expected ${canonical} or a positive numbered corrective release tag; got ${refName}`,
  );
}

function selfTest() {
  const canonical = `v${model.canonical}`;
  for (const registry of registries) {
    validate(`refs/tags/${canonical}`, canonical, registry);
    validate(`refs/tags/${canonical}-release.1`, `${canonical}-release.1`, registry);
  }
  for (const [ref, refName, registry] of [
    [`refs/heads/${canonical}`, canonical, "validate-only"],
    [`refs/tags/${canonical}-release.0`, `${canonical}-release.0`, "npm"],
    [`refs/tags/${canonical}-release`, `${canonical}-release`, "validate-only"],
    [`refs/tags/${canonical}-release.1`, `${canonical}-release.1`, "unknown"],
  ]) {
    let rejected = false;
    try {
      validate(ref, refName, registry);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`accepted forbidden release dispatch: ${refName}`);
  }
  console.log("release-ref authority self-test passed");
}

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const name = process.argv[index];
  if (name === "--self-test") {
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
} else {
  const ref = argumentsByName.get("--ref");
  const refName = argumentsByName.get("--ref-name");
  const registry = argumentsByName.get("--registry");
  if (![ref, refName, registry].every((value) => typeof value === "string")) {
    throw new Error("--ref, --ref-name, and --registry are required");
  }
  validate(ref, refName, registry);
  console.log(model.canonical);
}
