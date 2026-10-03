import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [runtimeTarball, interopTarball, duallityTarball, ...extra] = process.argv.slice(2);
if (!runtimeTarball || !interopTarball || extra.length > 0) {
  throw new Error(
    "usage: node scripts/verify-installed-consumer.mjs RUNTIME.tgz INTEROP.tgz [DUALLITY.tgz]",
  );
}
const build = join(root, ".build");
await mkdir(build, { recursive: true });
const scratch = await mkdtemp(join(build, "installed-consumer-check-"));
const cache = join(scratch, "npm-cache");
const environment = { ...process.env, npm_config_cache: cache };

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, env: environment, stdio: "inherit", timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? "without a status"}`);
  }
}

try {
  await writeFile(join(scratch, "package.json"), JSON.stringify({
    name: "vinary-tree-installed-consumer-probe", version: "0.0.0",
    private: true, type: "module",
  }));
  await copyFile(join(root, "test", "installed-consumer.probe.mjs"), join(scratch, "probe.mjs"));
  if (duallityTarball) {
    await copyFile(
      join(root, "test", "installed-duallity-consumer.probe.mjs"),
      join(scratch, "duallity-probe.mjs"),
    );
    await copyFile(
      join(root, "test", "installed-duallity-consumer.types.mts"),
      join(scratch, "duallity-types.mts"),
    );
  }
  run("npm", [
    "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    resolve(runtimeTarball), resolve(interopTarball),
    ...(duallityTarball ? [resolve(duallityTarball)] : []),
  ], scratch);
  run("node", ["probe.mjs"], scratch);
  if (duallityTarball) {
    run("node", ["duallity-probe.mjs"], scratch);
    const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
    run("node", [compiler, "--noEmit", "--strict", "--module", "nodenext",
      "--moduleResolution", "nodenext", "--target", "es2022",
      "duallity-types.mts"], scratch);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
