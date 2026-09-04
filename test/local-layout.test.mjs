import assert from "node:assert/strict";
import { mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  componentDirectories,
  createComponentSourceLayout,
  pinnedRustToolchain,
  runtimeRoot,
} from "../scripts/local-layout.mjs";

test("component source layout preserves every selected repository root", () => {
  const fixtureRoot = join(runtimeRoot, ".build", "local-layout-test");
  const sourceRoot = join(fixtureRoot, "sources");
  const layoutRoot = join(fixtureRoot, "layout");
  const roots = {};
  try {
    for (const key of Object.keys(componentDirectories)) {
      const source = join(sourceRoot, key);
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "Cargo.toml"), `[package]\nname = "${key}"\nversion = "1.0.0"\n`);
      roots[key] = source;
    }
    const layout = createComponentSourceLayout(layoutRoot, roots);
    for (const [key, directory] of Object.entries(componentDirectories)) {
      assert.equal(layout[key], join(layoutRoot, directory));
      if (process.platform !== "win32") assert.equal(readlinkSync(layout[key]), roots[key]);
    }
    assert.equal(layout.javascriptRuntime, join(layoutRoot, "javascript-runtime"));
    if (process.platform !== "win32") {
      assert.equal(readlinkSync(layout.javascriptRuntime), runtimeRoot);
    }
    assert.throws(
      () => createComponentSourceLayout(layoutRoot, { ...roots, duallity: undefined }),
      /missing: duallity/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("the native SDK toolchain pin is explicit and parseable", () => {
  const fixtureRoot = join(runtimeRoot, ".build", "toolchain-pin-test");
  try {
    mkdirSync(fixtureRoot, { recursive: true });
    writeFileSync(join(fixtureRoot, "rust-toolchain.toml"), "[toolchain]\nchannel = \"1.95.0\"\n");
    assert.equal(pinnedRustToolchain(fixtureRoot), "1.95.0");
    writeFileSync(join(fixtureRoot, "rust-toolchain.toml"), "[toolchain]\nprofile = \"minimal\"\n");
    assert.throws(() => pinnedRustToolchain(fixtureRoot), /has no channel/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
