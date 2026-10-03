import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { componentRoots } from "./local-layout.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const build = join(root, ".build");
await mkdir(build, { recursive: true });
const artifacts = await mkdtemp(join(build, "installed-family-pack-"));
const environment = { ...process.env, npm_config_cache: join(artifacts, "npm-cache") };

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, env: environment, encoding: "utf8", timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

function pack(source) {
  const output = run("npm", [
    "pack", "--json", "--ignore-scripts", "--pack-destination", artifacts,
  ], source);
  const manifest = JSON.parse(output);
  const packages = Array.isArray(manifest) ? manifest : Object.values(manifest);
  if (packages.length !== 1 || !packages[0].filename) {
    throw new Error(`expected one packed npm artifact from ${source}`);
  }
  return join(artifacts, packages[0].filename);
}

try {
  const runtime = pack(root);
  const interop = pack(join(componentRoots.interop, "bindings", "javascript"));
  const duallity = pack(join(componentRoots.duallity, "bindings", "javascript"));
  const output = run("node", [
    join(root, "scripts", "verify-installed-consumer.mjs"),
    runtime, interop, duallity,
  ], root);
  process.stdout.write(output);
} finally {
  await rm(artifacts, { recursive: true, force: true });
}
