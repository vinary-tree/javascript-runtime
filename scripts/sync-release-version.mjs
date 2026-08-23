import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const failures = [];
const expect = (name, actual, wanted) => {
  if (actual !== wanted) failures.push(`${name}: expected ${wanted}, got ${actual}`);
};
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
if (failures.length > 0) throw new Error(failures.join("\n"));
console.log(`release versions agree with ${model.canonical}`);
