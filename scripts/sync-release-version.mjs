import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSourceRefs } from "./release-source-refs.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const model = JSON.parse(readFileSync(join(root, "release", "version.json"), "utf8"));
const write = process.argv.includes("--write");
if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(model.canonical)) {
  throw new Error(`canonical version is not a numbered RC: ${model.canonical}`);
}
const summary = model.metadata?.summary;
const description = model.metadata?.description;
if (typeof summary !== "string" || summary.length === 0 || summary.length > 80) {
  throw new Error("release metadata summary must contain 1 through 80 characters");
}
if (summary.endsWith(".")) {
  throw new Error("release metadata summary must not end with a period");
}
if (typeof description !== "string" || !description.endsWith(".")) {
  throw new Error("release metadata description must be non-empty and end with a period");
}
const npmPackage = model.coordinates?.npmPackage;
const npmPropertyTestPackage = model.coordinates?.npmPropertyTestPackage;
const legacyInteropPackage = ["@vinary-tree", "interop"].join("/");
if (npmPackage !== "@vinary-tree/javascript-runtime") {
  throw new Error(
    "release/version.json coordinates.npmPackage must be @vinary-tree/javascript-runtime",
  );
}
if (npmPropertyTestPackage !== "@vinary-tree/javascript-runtime-property-tests") {
  throw new Error(
    "release/version.json coordinates.npmPropertyTestPackage must be " +
      "@vinary-tree/javascript-runtime-property-tests",
  );
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
    value.name = npmPackage;
    value.version = model.npm;
    value.description = description;
    delete value.dependencies[legacyInteropPackage];
    value.dependencies["@vinary-tree/vinary-tree-interop"] =
      model.dependencies["@vinary-tree/vinary-tree-interop"];
    value.publishConfig.tag = model.distTag;
  }
});
const propertyPackage = updateJson("test-property/package.json", (value) => {
  if (write) {
    value.name = npmPropertyTestPackage;
    value.version = model.canonical;
  }
});
const propertyLock = updateJson("test-property/package-lock.json", (value) => {
  if (write) {
    value.name = npmPropertyTestPackage;
    value.version = model.canonical;
    value.packages[""].name = npmPropertyTestPackage;
    value.packages[""].version = model.canonical;
  }
});

const cargoPath = join(root, "rust", "Cargo.toml");
let cargo = readFileSync(cargoPath, "utf8");
if (write) {
  cargo = cargo.replace(/^version = "[^"]+"/m, `version = "${model.canonical}"`);
  cargo = cargo.replace(/^description = "[^"]+"/m, `description = "${description}"`);
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
  "docs/diagrams/release-dependency-graph.puml",
  "docs/diagrams/runtime-architecture.puml",
]);

const failures = [];
const expect = (name, actual, wanted) => {
  if (actual !== wanted) failures.push(`${name}: expected ${wanted}, got ${actual}`);
};
const escapedCanonical = model.canonical.replaceAll(".", "\\.");
if (!new RegExp(`^v${escapedCanonical}(?:-release\\.[1-9][0-9]*)?$`).test(model.sourceTag)) {
  failures.push(
    `source tag must be v${model.canonical} or an append-only numbered correction, got ${model.sourceTag}`,
  );
}
validateSourceRefs(model);
const releaseWorkflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
for (const marker of [
  "scripts/check-release-ref.mjs",
  'environment: github-release',
  'environment: npm',
]) {
  if (!releaseWorkflow.includes(marker)) failures.push(`release workflow is missing ${marker}`);
}
expect("npm package", packageJson.name, npmPackage);
expect("npm", packageJson.version, model.npm);
expect("npm description", packageJson.description, description);
expect(
  "npm interop",
  packageJson.dependencies["@vinary-tree/vinary-tree-interop"],
  model.dependencies["@vinary-tree/vinary-tree-interop"],
);
expect("legacy npm interop dependency", packageJson.dependencies[legacyInteropPackage], undefined);
expect("npm dist-tag", packageJson.publishConfig.tag, model.distTag);
expect("property package name", propertyPackage.name, npmPropertyTestPackage);
expect("property package", propertyPackage.version, model.canonical);
expect("property lock name", propertyLock.name, npmPropertyTestPackage);
expect("property lock", propertyLock.version, model.canonical);
expect("property lock root name", propertyLock.packages[""].name, npmPropertyTestPackage);
expect("property lock root", propertyLock.packages[""].version, model.canonical);
expect("Rust package", cargo.match(/^version = "([^"]+)"/m)?.[1], model.canonical);
expect("Rust description", cargo.match(/^description = "([^"]+)"/m)?.[1], description);
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

const ignoredCoordinateTrees = new Set([
  ".git",
  ".build",
  "build",
  "dist",
  "generated",
  "native/prebuilds",
  "node_modules",
  "target",
]);
const coordinateMigrationRecord = "docs/npm-coordinate-migration.md";
const forbiddenCoordinates = [
  ["legacy interop coordinate", legacyInteropPackage],
  ["legacy runtime coordinate", ["@vinary-tree", "vinary-tree"].join("/")],
  [
    "malformed runtime/interop composition",
    ["@vinary-tree", "javascript-runtime-interop"].join("/"),
  ],
];

function coordinateViolation(source) {
  for (const [label, coordinate] of forbiddenCoordinates) {
    const escaped = coordinate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}(?![A-Za-z0-9._-])`).exec(source);
    if (match !== null) return { label, index: match.index };
  }
  return undefined;
}

for (const coordinate of [
  "@vinary-tree/vinary-tree-interop",
  "@vinary-tree/javascript-runtime",
  "@vinary-tree/javascript-runtime/wasm",
]) {
  expect(`coordinate gate accepts ${coordinate}`, coordinateViolation(coordinate), undefined);
}
for (const [label, coordinate] of forbiddenCoordinates) {
  expect(
    `coordinate gate rejects ${label}`,
    coordinateViolation(`"${coordinate}@4.0.0-rc.4"`)?.label,
    label,
  );
}

function validateNpmCoordinates(directory = root, relativeDirectory = "") {
  for (const entry of readdirSync(directory)) {
    const relative = relativeDirectory === "" ? entry : `${relativeDirectory}/${entry}`;
    if ([...ignoredCoordinateTrees].some((tree) => relative === tree || relative.startsWith(`${tree}/`))) {
      continue;
    }
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      validateNpmCoordinates(absolute, relative);
      continue;
    }
    if (relative === coordinateMigrationRecord) continue;
    let source;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (source.includes("\0")) continue;
    const violation = coordinateViolation(source);
    if (violation !== undefined) {
      const line = source.slice(0, violation.index).split("\n").length;
      failures.push(`${relative}:${line}: ${violation.label} is forbidden`);
    }
  }
}

validateNpmCoordinates();
if (failures.length > 0) throw new Error(failures.join("\n"));
console.log(`release versions agree with ${model.canonical}`);
