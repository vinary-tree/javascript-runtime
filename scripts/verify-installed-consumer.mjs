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
const jvmTemporary = join(scratch, "jvm-tmp");
const environment = { ...process.env, npm_config_cache: cache, TMPDIR: jvmTemporary };

function run(command, args, cwd, timeout = 120_000) {
  const result = spawnSync(command, args, {
    cwd, env: environment, stdio: "inherit", timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? "without a status"}`);
  }
}

try {
  await mkdir(jvmTemporary);
  await writeFile(join(scratch, "package.json"), JSON.stringify({
    name: "vinary-tree-installed-consumer-probe", version: "0.0.0",
    private: true, type: "module",
  }));
  await copyFile(join(root, "test", "installed-consumer.probe.mjs"), join(scratch, "probe.mjs"));
  if (duallityTarball) {
    await mkdir(join(scratch, "cljs", "vinary_tree"), { recursive: true });
    await copyFile(
      join(root, "test", "installed-duallity-consumer.probe.mjs"),
      join(scratch, "duallity-probe.mjs"),
    );
    await copyFile(
      join(root, "test", "installed-duallity-consumer.types.mts"),
      join(scratch, "duallity-types.mts"),
    );
    await copyFile(
      join(root, "test", "installed-duallity-consumer.cljs"),
      join(scratch, "cljs", "vinary_tree", "installed_duallity_consumer.cljs"),
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
    const duallityNamespace = join(
      scratch, "node_modules", "@vinary-tree", "duallity", "cljs",
    );
    const sourcePaths = `{:paths [${JSON.stringify(join(scratch, "cljs"))} ` +
      `${JSON.stringify(duallityNamespace)}] ` +
      ":deps {org.clojure/clojurescript {:mvn/version \"1.12.145\"}}}";
    // cljs.main embeds -d relative to process.cwd() in its Node entry point.
    const output = "cljs-out";
    run("clojure", ["-J-Xmx2g", `-J-Djava.io.tmpdir=${jvmTemporary}`,
      "-Sdeps", sourcePaths, "-M", "-m", "cljs.main", "-t", "node",
      "-O", "none", "-d", output, "-c", "vinary-tree.installed-duallity-consumer"],
    scratch, 300_000);
    await writeFile(join(scratch, output, "package.json"), JSON.stringify({ type: "commonjs" }));
    run("node", [join(scratch, output, "main.js")], scratch);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
