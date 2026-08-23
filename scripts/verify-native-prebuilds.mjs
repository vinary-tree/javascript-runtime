import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const model = JSON.parse(readFileSync(join(root, "release", "version.json"), "utf8"));
const prebuildRoot = join(root, "native", "prebuilds");
const expected = new Set(model.nativePrebuilds);
const actual = new Set(existsSync(prebuildRoot)
  ? readdirSync(prebuildRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : []);

for (const platform of expected) {
  const addon = join(prebuildRoot, platform, "vinary_tree_native.node");
  if (!existsSync(addon)) throw new Error(`native release omits ${platform}`);
}
for (const platform of actual) {
  if (!expected.has(platform)) throw new Error(`native release contains undeclared platform ${platform}`);
}
console.log(`native release contains all ${expected.size} declared prebuilds`);
