#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(runtimeRoot, "release", "version.json");

export const sourceOwners = Object.freeze([
  "vinary-tree-interop",
  "llattice",
  "libdictenstein",
  "liblevenshtein-rust",
  "lling-llang",
  "duallity",
]);

export function expectedSourceVersions(model) {
  return Object.freeze({
    "vinary-tree-interop": model.dependencies?.["vinary-tree-interop"],
    llattice: model.dependencies?.llattice,
    libdictenstein: model.dependencies?.libdictenstein,
    "liblevenshtein-rust": model.dependencies?.liblevenshtein,
    "lling-llang": model.dependencies?.["lling-llang"],
    duallity: model.dependencies?.duallity,
  });
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function validateSourceRefs(model) {
  const expected = expectedSourceVersions(model);
  const actualOwners = Object.keys(model.sourceRefs ?? {}).sort();
  const wantedOwners = [...sourceOwners].sort();
  if (JSON.stringify(actualOwners) !== JSON.stringify(wantedOwners)) {
    throw new Error("sourceRefs must name every and only runtime source owner");
  }

  const validated = {};
  for (const owner of sourceOwners) {
    const version = expected[owner];
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(`release model has no non-empty version for ${owner}`);
    }
    const ref = model.sourceRefs[owner];
    const pattern = new RegExp(`^v${escapeRegExp(version)}(?:-release\\.[1-9][0-9]*)?$`);
    if (typeof ref !== "string" || !pattern.test(ref)) {
      throw new Error(`sourceRefs.${owner} must be an immutable ${version} release tag`);
    }
    validated[owner] = ref;
  }
  return Object.freeze(validated);
}

export function readReleaseModel() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function selfTest() {
  const valid = {
    dependencies: {
      "vinary-tree-interop": "4.0.0-rc.4",
      llattice: "0.1.0",
      libdictenstein: "4.0.0-rc.4",
      liblevenshtein: "4.0.0-rc.4",
      "lling-llang": "4.0.0-rc.4",
      duallity: "4.0.0-rc.4",
    },
    sourceRefs: {
      "vinary-tree-interop": "v4.0.0-rc.4-release.3",
      llattice: "v0.1.0",
      libdictenstein: "v4.0.0-rc.4-release.1",
      "liblevenshtein-rust": "v4.0.0-rc.4-release.3",
      "lling-llang": "v4.0.0-rc.4-release.1",
      duallity: "v4.0.0-rc.4-release.1",
    },
  };
  validateSourceRefs(valid);
  const mutations = [
    (model) => delete model.sourceRefs.duallity,
    (model) => { model.sourceRefs.unexpected = "v4.0.0-rc.4"; },
    (model) => { model.sourceRefs.libdictenstein = "master"; },
    (model) => { model.sourceRefs.libdictenstein = "208d9cd6ccfc4993acddd3c166bb314049dfb258"; },
    (model) => { model.sourceRefs.libdictenstein = "v4.0.0-rc.3"; },
    (model) => { model.sourceRefs.libdictenstein = "v4.0.0-rc.4-release.0"; },
    (model) => { model.sourceRefs.libdictenstein = "v4.0.0-rc.4-release.next"; },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    let rejected = false;
    try {
      validateSourceRefs(malformed);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`malformed sourceRefs passed validation: ${JSON.stringify(malformed)}`);
  }
  console.log("release source-ref hostile-input tests passed");
}

function main() {
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
    return;
  }
  const refs = validateSourceRefs(readReleaseModel());
  const owner = argumentsByName.get("--component");
  if (owner !== undefined) {
    if (!(owner in refs)) throw new Error(`release source manifest has no ref for ${owner}`);
    console.log(refs[owner]);
  } else {
    for (const [name, ref] of Object.entries(refs)) console.log(`${name}\t${ref}`);
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
