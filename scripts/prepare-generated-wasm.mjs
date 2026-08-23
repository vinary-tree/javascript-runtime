import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const generated = join(root, "generated", "wasm");
for (const file of ["vinary_tree.js", "vinary_tree_bg.wasm"]) {
  if (!existsSync(join(generated, file))) {
    throw new Error(`wasm-pack omitted generated/wasm/${file}`);
  }
}

// wasm-pack creates a nested `*` ignore file for publishing its output as a
// standalone package. This repository deliberately embeds the two runtime
// artifacts in its parent npm package, where that ignore rule would silently
// override the parent's explicit `files` allowlist.
rmSync(join(generated, ".gitignore"), { force: true });
console.log("prepared browser WebAssembly files for parent-package assembly");
