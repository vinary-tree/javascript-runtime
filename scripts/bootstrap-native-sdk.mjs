import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  cargoPackageVersion,
  componentRoots,
  requireComponentRoots,
  runtimeRoot,
  writeLocalCargoConfig,
} from "./local-layout.mjs";

const skipBuild = process.argv.includes("--skip-build");
const model = JSON.parse(readFileSync(join(runtimeRoot, "release", "version.json"), "utf8"));
const buildRoot = join(runtimeRoot, ".build", "components");
const sdkRoot = join(runtimeRoot, ".build", "native-sdk");

const builds = [
  { key: "libdictenstein", root: componentRoots.libdictenstein, crate: "libdictenstein" },
  { key: "liblevenshtein", root: componentRoots.liblevenshtein, crate: "liblevenshtein" },
  { key: "lling-llang", root: componentRoots.llingLlang, crate: "lling_llang" },
  { key: "duallity", root: componentRoots.duallity, crate: "duallity" },
];

const expected = new Map([
  [componentRoots.duallity, model.dependencies.duallity],
  [componentRoots.interop, model.dependencies["vinary-tree-interop"]],
  [componentRoots.libdictenstein, model.dependencies.libdictenstein],
  [componentRoots.liblevenshtein, model.dependencies.liblevenshtein],
  [componentRoots.llingLlang, model.dependencies["lling-llang"]],
]);

requireComponentRoots();
for (const [root, version] of expected) {
  const actual = cargoPackageVersion(root);
  if (actual !== version) throw new Error(`${root} must be ${version}; found ${actual}`);
}
writeLocalCargoConfig();

function runCargo(build) {
  const args = [
    "build",
    "--manifest-path", join(build.root, "Cargo.toml"),
    "--target-dir", join(buildRoot, build.key),
    "--release",
    "--lib",
    "--no-default-features",
    "--features", "native-bindings-full",
  ];
  const result = spawnSync("cargo", args, { cwd: runtimeRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo build failed for ${build.key}`);
}

function sourceCommit(root) {
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cannot resolve source commit under ${root}`);
  return result.stdout.trim();
}

if (!skipBuild) for (const build of builds) runCargo(build);

rmSync(sdkRoot, { recursive: true, force: true });
mkdirSync(join(sdkRoot, "include"), { recursive: true });
mkdirSync(join(sdkRoot, "lib"), { recursive: true });

const headers = [
  [componentRoots.interop, "vinary_tree_interop.h"],
  [componentRoots.libdictenstein, "libdictenstein.h"],
  [componentRoots.libdictenstein, "libdictenstein.hpp"],
  [componentRoots.liblevenshtein, "liblevenshtein_abi.h"],
  [componentRoots.liblevenshtein, "liblevenshtein.h"],
  [componentRoots.liblevenshtein, "liblevenshtein.hpp"],
  [componentRoots.llingLlang, "lling_llang.h"],
  [componentRoots.llingLlang, "lling_llang.hpp"],
  [componentRoots.duallity, "duallity.h"],
  [componentRoots.duallity, "duallity.hpp"],
];
for (const [root, header] of headers) {
  copyFileSync(join(root, "include", header), join(sdkRoot, "include", header));
}
const stagedHeaders = new Set(headers.map(([, header]) => header));
for (const [, header] of headers) {
  const source = readFileSync(join(sdkRoot, "include", header), "utf8");
  for (const match of source.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) {
    if (!stagedHeaders.has(match[1])) {
      throw new Error(`${header} includes unstaged SDK header ${match[1]}`);
    }
  }
}

const windows = process.platform === "win32";
for (const build of builds) {
  const name = windows ? `${build.crate}.lib` : `lib${build.crate}.a`;
  const source = join(buildRoot, build.key, "release", name);
  copyFileSync(source, join(sdkRoot, "lib", basename(source)));
}

writeFileSync(join(sdkRoot, "provenance.json"), `${JSON.stringify({
  canonicalVersion: model.canonical,
  generatedAt: new Date().toISOString(),
  sourceCommits: Object.fromEntries(
    Object.entries(componentRoots).map(([name, root]) => [name, sourceCommit(root)]),
  ),
  headers: headers.map(([root, header]) => ({ header, sourceRoot: root })),
  sourceRoots: componentRoots,
}, null, 2)}\n`);
console.log(`staged standalone native SDK: ${sdkRoot}`);
