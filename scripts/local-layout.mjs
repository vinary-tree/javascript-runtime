import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const familyRoot = dirname(runtimeRoot);

const component = (environment, directory) =>
  resolve(process.env[environment] ?? join(familyRoot, directory));

export const componentRoots = Object.freeze({
  duallity: component("VINARY_TREE_DUALLITY_ROOT", "duallity"),
  interop: component("VINARY_TREE_INTEROP_ROOT", "vinary-tree-interop"),
  llattice: component("VINARY_TREE_LLATTICE_ROOT", "llattice"),
  libdictenstein: component("VINARY_TREE_LIBDICTENSTEIN_ROOT", "libdictenstein"),
  liblevenshtein: component("VINARY_TREE_LIBLEVENSHTEIN_ROOT", "liblevenshtein-rust"),
  llingLlang: component("VINARY_TREE_LLING_LLANG_ROOT", "lling-llang"),
});

export const componentDirectories = Object.freeze({
  duallity: "duallity",
  interop: "vinary-tree-interop",
  llattice: "llattice",
  libdictenstein: "libdictenstein",
  liblevenshtein: "liblevenshtein-rust",
  llingLlang: "lling-llang",
});

const isWithin = (parent, candidate) => {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

export function requireComponentRoots() {
  for (const [name, root] of Object.entries(componentRoots)) {
    if (isWithin(runtimeRoot, root)) {
      throw new Error(
        `${name} must be checked out beside ${runtimeRoot}, not beneath it; ` +
        "nested owner builds inherit the runtime Cargo patch overlay",
      );
    }
    if (!existsSync(join(root, "Cargo.toml"))) {
      throw new Error(`${name} Cargo.toml is missing under ${root}`);
    }
  }
}

/**
 * Materialize the canonical sibling checkout topology expected by the family
 * crates while retaining each explicitly selected source root. Directory
 * junctions are used on Windows because they do not require Developer Mode;
 * Unix uses directory symlinks. Cargo deliberately preserves the manifest's
 * lexical path, so relative path dependencies resolve through this topology.
 */
export function createComponentSourceLayout(destination, roots = componentRoots) {
  const missing = Object.keys(componentDirectories).filter((key) => roots[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`component source layout is missing: ${missing.join(", ")}`);
  }
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const linked = {};
  for (const [key, directory] of Object.entries(componentDirectories)) {
    const source = resolve(roots[key]);
    if (!existsSync(join(source, "Cargo.toml"))) {
      throw new Error(`${key} Cargo.toml is missing under ${source}`);
    }
    const target = join(destination, directory);
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    linked[key] = target;
  }
  const runtimeTarget = join(destination, "javascript-runtime");
  symlinkSync(runtimeRoot, runtimeTarget, process.platform === "win32" ? "junction" : "dir");
  linked.javascriptRuntime = runtimeTarget;
  return Object.freeze(linked);
}

export function cargoPackageVersion(root) {
  const manifest = readFileSync(join(root, "Cargo.toml"), "utf8");
  const packageSection = manifest.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1];
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (version === undefined) throw new Error(`package version is missing from ${root}/Cargo.toml`);
  return version;
}

export function pinnedRustToolchain(root = runtimeRoot) {
  const source = readFileSync(join(root, "rust-toolchain.toml"), "utf8");
  const channel = source.match(/^\s*channel\s*=\s*"([^"]+)"/m)?.[1];
  if (channel === undefined) throw new Error(`${root}/rust-toolchain.toml has no channel`);
  return channel;
}

const tomlPath = (path) => JSON.stringify(path);

const packageNames = Object.freeze({
  duallity: "duallity",
  interop: "vinary-tree-interop",
  llattice: "llattice",
  libdictenstein: "libdictenstein",
  liblevenshtein: "liblevenshtein",
  llingLlang: "lling-llang",
});

function sourceSpecificPatches() {
  const families = new Set([
    familyRoot,
    ...Object.values(componentRoots).map((root) => dirname(root)),
  ]);
  return [...families]
    .flatMap((family) => Object.entries(componentDirectories).map(([key, directory]) => ({
      key,
      sourceRoot: resolve(family, directory),
    })))
    .filter(({ key, sourceRoot }) => sourceRoot !== componentRoots[key])
    .map(({ key, sourceRoot }) => {
      const source = pathToFileURL(sourceRoot).href;
      return `[patch.${JSON.stringify(source)}]\n${packageNames[key]} = { path = ${tomlPath(componentRoots[key])} }\n`;
    })
    .join("\n");
}

export function writeLocalCargoConfig() {
  requireComponentRoots();
  const directory = join(runtimeRoot, ".cargo");
  const path = join(directory, "config.toml");
  mkdirSync(directory, { recursive: true });
  const config = `# Generated by npm run configure:local; never publish this path overlay.
[patch.crates-io]
duallity = { path = ${tomlPath(componentRoots.duallity)} }
llattice = { path = ${tomlPath(componentRoots.llattice)} }
libdictenstein = { path = ${tomlPath(componentRoots.libdictenstein)} }
liblevenshtein = { path = ${tomlPath(componentRoots.liblevenshtein)} }
lling-llang = { path = ${tomlPath(componentRoots.llingLlang)} }
vinary-tree-interop = { path = ${tomlPath(componentRoots.interop)} }

${sourceSpecificPatches()}

[target.'cfg(all(any(target_arch = "x86", target_arch = "x86_64"), any(target_os = "linux", target_os = "macos", target_os = "windows")))']
rustflags = ["-C", "target-feature=+aes,+sse2"]

[target.'cfg(all(any(target_arch = "arm", target_arch = "aarch64"), any(target_os = "linux", target_os = "macos", target_os = "windows")))']
rustflags = ["-C", "target-feature=+aes,+neon"]

[target.wasm32-unknown-unknown]
rustflags = ["--cfg", "getrandom_backend=\\"wasm_js\\""]
`;
  writeFileSync(path, config);
  return path;
}
