import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const release = JSON.parse(readFileSync(join(root, "release", "version.json"), "utf8"));
const packageName = release.coordinates?.npmPackage;
if (packageName !== "@vinary-tree/javascript-runtime") {
  throw new Error("release manifest does not name the canonical JavaScript runtime package");
}

const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const parsed = JSON.parse(result.stdout);
const report = Array.isArray(parsed)
  ? parsed[0]
  : parsed.files
    ? parsed
    : parsed[packageName] ?? Object.values(parsed)[0];
if (!report || !Array.isArray(report.files)) {
  throw new Error("npm pack returned no package file report");
}
const paths = new Set(report.files.map((entry) => entry.path));
for (const required of [
  "LICENSE",
  "README.md",
  "docs/api-reference.md",
  "index.d.ts",
  "native.mjs",
  "native.cjs",
  "wasm.mjs",
  "wasi.mjs",
  "wasi.d.ts",
  "generated/wasm/vinary_tree.js",
  "generated/wasm/vinary_tree_bg.wasm",
  "generated/wasi/vinary_tree.wasm",
]) {
  if (!paths.has(required)) throw new Error(`npm artifact omits ${required}`);
}
for (const forbidden of ["rust/Cargo.toml", "native/src/addon.cc", "release/version.json"]) {
  if (paths.has(forbidden)) throw new Error(`npm artifact leaks source-only file ${forbidden}`);
}
console.log(`npm artifact contains ${report.entryCount} files (${report.unpackedSize} bytes unpacked)`);
