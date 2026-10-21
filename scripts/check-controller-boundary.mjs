import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

const forbidden = ["@switchyard/reporting", "@switchyard/azure-ledger-bootstrap"];

for (const controllerRoot of [
  "packages/controller",
  "packages/azure-worker",
  "packages/reconciler",
]) {
  const manifest = JSON.parse(readFileSync(join(controllerRoot, "package.json"), "utf8"));
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const name of forbidden) {
      assert.equal(
        manifest[section]?.[name],
        undefined,
        `${controllerRoot} ${section} must not contain ${name}`,
      );
    }
  }

  for (const root of [join(controllerRoot, "src"), join(controllerRoot, "dist")]) {
    if (!existsSync(root)) continue;
    for (const file of filesBelow(root)) {
      if (![".js", ".ts", ".map"].includes(extname(file))) continue;
      const contents = readFileSync(file, "utf8");
      for (const name of forbidden) {
        assert.equal(contents.includes(name), false, `${file} contains forbidden ${name}`);
      }
    }
  }
}

for (const controllerRoot of [
  "packages/controller",
  "packages/azure-worker",
  "packages/reconciler",
]) {
  for (const file of filesBelow(join(controllerRoot, "src"))) {
    if (![".js", ".ts"].includes(extname(file))) continue;
    assert.equal(
      readFileSync(file, "utf8").includes("@azure/functions"),
      false,
      `${file} must remain portable and cannot register Azure Functions`,
    );
  }
}

assert.equal(existsSync("apps/control-function/src/entry.ts"), true, "Function entry is missing");
const runtimeManifest = JSON.parse(readFileSync("apps/control-function/package.json", "utf8"));
for (const section of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]) {
  for (const name of forbidden) {
    assert.equal(
      runtimeManifest[section]?.[name],
      undefined,
      `control Function ${section} must not contain ${name}`,
    );
  }
}
console.log("Verified the portable controller dependency and runtime boundary.");

function* filesBelow(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* filesBelow(path);
    else if (entry.isFile()) yield path;
  }
}
