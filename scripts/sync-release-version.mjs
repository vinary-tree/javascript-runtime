import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSourceRefs } from "./release-source-refs.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const model = JSON.parse(readFileSync(join(root, "release", "version.json"), "utf8"));
const write = process.argv.includes("--write");
if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(model.canonical)) {
  throw new Error(`canonical version is not a numbered RC: ${model.canonical}`);
}
const nativePrebuilds = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
];
if (JSON.stringify(model.nativePrebuilds) !== JSON.stringify(nativePrebuilds)) {
  throw new Error(`nativePrebuilds must be ${nativePrebuilds.join(", ")}`);
}

function updateJson(path, mutate) {
  const absolute = join(root, path);
  const value = JSON.parse(readFileSync(absolute, "utf8"));
  mutate(value);
  if (write) writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

function rewriteCandidateTokens(paths) {
  if (!write) return;
  const [base, candidate] = model.canonical.split("-rc.");
  const escaped = base.replaceAll(".", "\\.");
  const replacements = [
    [new RegExp(`${escaped}\\.rc\\.\\d+`, "g"), `${base}.rc.${candidate}`],
    [new RegExp(`${escaped}~rc\\d+`, "g"), `${base}~rc${candidate}`],
    [new RegExp(`${escaped}rc\\d+-\\d+`, "g"), `${base}rc${candidate}-1`],
    [new RegExp(`${escaped}rc\\d+`, "g"), `${base}rc${candidate}`],
    [new RegExp(`${escaped}-rc\\.\\d+`, "g"), model.canonical],
  ];
  for (const path of paths) {
    const absolute = join(root, path);
    let source = readFileSync(absolute, "utf8");
    for (const [pattern, replacement] of replacements) {
      source = source.replace(pattern, replacement);
    }
    writeFileSync(absolute, source);
  }
}

const packageJson = updateJson("package.json", (value) => {
  if (write) {
    value.version = model.npm;
    value.dependencies["@vinary-tree/interop"] = model.dependencies["@vinary-tree/interop"];
    value.publishConfig.tag = model.distTag;
  }
});
const propertyPackage = updateJson("test-property/package.json", (value) => {
  if (write) value.version = model.canonical;
});
const propertyLock = updateJson("test-property/package-lock.json", (value) => {
  if (write) {
    value.version = model.canonical;
    value.packages[""].version = model.canonical;
  }
});

const cargoPath = join(root, "rust", "Cargo.toml");
let cargo = readFileSync(cargoPath, "utf8");
if (write) {
  cargo = cargo.replace(/^version = "[^"]+"/m, `version = "${model.canonical}"`);
  for (const dependency of ["duallity", "libdictenstein", "liblevenshtein", "lling-llang"]) {
    const escaped = dependency.replace("-", "\\-");
    cargo = cargo.replace(
      new RegExp(`^(${escaped} = \\{[^\\n]*version = \")=[^\"]+` , "m"),
      `$1=${model.dependencies[dependency]}`,
    );
  }
  cargo = cargo.replace(
    /^vinary-tree-interop = "=[^"]+"/m,
    `vinary-tree-interop = "=${model.dependencies["vinary-tree-interop"]}"`,
  );
  writeFileSync(cargoPath, cargo);
}
const cargoLockPath = join(root, "rust", "Cargo.lock");
let cargoLock = readFileSync(cargoLockPath, "utf8");
const lockedReleasePackages = new Map([
  ["vinary-tree-js-runtime", model.canonical],
  ["duallity", model.dependencies.duallity],
  ["libdictenstein", model.dependencies.libdictenstein],
  ["liblevenshtein", model.dependencies.liblevenshtein],
  ["lling-llang", model.dependencies["lling-llang"]],
  ["vinary-tree-interop", model.dependencies["vinary-tree-interop"]],
]);
for (const [name, version] of lockedReleasePackages) {
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")[^"]+`, "m");
  if (!pattern.test(cargoLock)) {
    throw new Error(`rust/Cargo.lock has no package entry for ${name}`);
  }
  if (write) cargoLock = cargoLock.replace(pattern, `$1${version}`);
}
if (write) writeFileSync(cargoLockPath, cargoLock);
rewriteCandidateTokens([
  ".github/workflows/ci.yml",
  "README.md",
  "docs/releasing.md",
  "docs/diagrams/release-dependency-graph.puml",
  "docs/diagrams/runtime-architecture.puml",
]);

const failures = [];
const expect = (name, actual, wanted) => {
  if (actual !== wanted) failures.push(`${name}: expected ${wanted}, got ${actual}`);
};
expect("corrective source tag", model.sourceTag, `v${model.canonical}-release.3`);
validateSourceRefs(model);
const releaseWorkflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
for (const marker of [
  "scripts/check-release-ref.mjs",
  'environment: github-release',
  'environment: npm',
]) {
  if (!releaseWorkflow.includes(marker)) failures.push(`release workflow is missing ${marker}`);
}
expect("npm", packageJson.version, model.npm);
expect("npm interop", packageJson.dependencies["@vinary-tree/interop"], model.dependencies["@vinary-tree/interop"]);
expect("npm dist-tag", packageJson.publishConfig.tag, model.distTag);
expect("property package", propertyPackage.version, model.canonical);
expect("property lock", propertyLock.version, model.canonical);
expect("property lock root", propertyLock.packages[""].version, model.canonical);
expect("Rust package", cargo.match(/^version = "([^"]+)"/m)?.[1], model.canonical);
for (const dependency of ["duallity", "libdictenstein", "liblevenshtein", "lling-llang"]) {
  const escaped = dependency.replace("-", "\\-");
  expect(
    `Rust ${dependency}`,
    cargo.match(new RegExp(`^${escaped} = \\{[^\\n]*version = "=([^\"]+)"`, "m"))?.[1],
    model.dependencies[dependency],
  );
}
expect(
  "Rust interop",
  cargo.match(/^vinary-tree-interop = "=([^"]+)"/m)?.[1],
  model.dependencies["vinary-tree-interop"],
);
for (const [name, version] of lockedReleasePackages) {
  const escaped = name.replaceAll("-", "\\-");
  expect(
    `Rust lock ${name}`,
    cargoLock.match(new RegExp(`\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = "([^"]+)"`, "m"))?.[1],
    version,
  );
}
if (failures.length > 0) throw new Error(failures.join("\n"));
console.log(`release versions agree with ${model.canonical}`);
