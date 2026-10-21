import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertRuntimeAppBoundary } from "./check-runtime-app-boundary.mjs";

const packageDefinitions = [
  {
    modules: [
      "allocation-identity",
      "allocation-ledger",
      "allocation-policy",
      "azure-generation-naming",
      "backup-choice",
      "capabilities",
      "check-run",
      "controller-health",
      "github-trust",
      "index",
      "post-job-visibility",
      "provider-limits",
      "provider",
      "strict-json",
      "testing/fake-provider",
      "testing/in-memory-allocation-ledger",
      "testing/index",
      "validation",
      "workflow-contract",
    ],
    workspace: "@switchyard/core",
  },
  {
    modules: ["blacksmith", "http", "index", "projection", "proof", "service"],
    workspace: "@switchyard/controller",
  },
  {
    modules: ["delivery", "http-sink", "index", "report", "usage-record"],
    workspace: "@switchyard/reporting",
  },
  {
    modules: [
      "api",
      "app-auth",
      "check-run-reporter",
      "index",
      "workload-mapping",
      "testing/fakes",
      "trust-verifier",
      "workflow-yaml",
    ],
    workspace: "@switchyard/github",
  },
  { modules: ["index"], workspace: "@switchyard/azure-ledger" },
  { modules: ["index"], workspace: "@switchyard/azure-ledger-bootstrap" },
  { modules: ["index"], workspace: "@switchyard/azure-worker" },
  { modules: ["index"], workspace: "@switchyard/reconciler" },
  { modules: ["index"], workspace: "@switchyard/recovery" },
  {
    modules: [
      "activation",
      "apply-engine",
      "artifact-live",
      "authority",
      "azure-live",
      "bundle",
      "cli",
      "chronology",
      "contracts",
      "entra-live",
      "github-evidence",
      "github-live",
      "identity",
      "index",
      "initial-state-engine",
      "opentofu",
      "opentofu-live",
      "plan-engine",
      "state",
      "zip",
    ],
    workspace: "@switchyard/infrastructure-approval",
  },
];

for (const entry of packageDefinitions) {
  const expectedFiles = [
    "package.json",
    ...entry.modules.flatMap((module) =>
      ["d.ts", "d.ts.map", "js", "js.map"].map((extension) => `dist/${module}.${extension}`),
    ),
  ].sort();
  const output = execFileSync(
    "npm",
    ["pack", "--workspace", entry.workspace, "--dry-run", "--json", "--ignore-scripts"],
    { encoding: "utf8" },
  );
  const packResults = JSON.parse(output);

  assert.equal(packResults.length, 1, `${entry.workspace} should produce exactly one package`);
  const actualFiles = packResults[0].files.map(({ path }) => path).sort();
  assert.deepEqual(
    actualFiles,
    expectedFiles,
    `${entry.workspace} package contents differ from the allowlist`,
  );
  console.log(`Verified ${actualFiles.length} files in the ${entry.workspace} package dry run.`);
}

const runtimeManifest = readManifest("packages/azure-ledger/package.json");
assert.deepEqual(Object.keys(runtimeManifest.exports), ["."], "runtime exports bootstrap code");
assert.equal(
  runtimeManifest.dependencies["@switchyard/azure-ledger-bootstrap"],
  undefined,
  "runtime depends on the provisioning-only package",
);
assert.equal(
  runtimeManifest.dependencies["@azure/core-auth"],
  undefined,
  "runtime contains the bootstrap credential contract",
);

for (const directory of ["apps", "packages"]) {
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    if (!child.isDirectory()) {
      continue;
    }
    const manifestPath = join(directory, child.name, "package.json");
    let manifest;
    try {
      manifest = readManifest(manifestPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (manifest.name === "@switchyard/azure-ledger-bootstrap") {
      continue;
    }
    for (const dependencySection of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      assert.equal(
        manifest[dependencySection]?.["@switchyard/azure-ledger-bootstrap"],
        undefined,
        `${manifest.name} must not list the provisioning-only ledger package in ${dependencySection}`,
      );
    }
  }
}

const workerOutputDirectory = mkdtempSync(join(tmpdir(), "switchyard-reporting-worker-"));
try {
  execFileSync(
    join("node_modules", ".bin", "wrangler"),
    [
      "deploy",
      "--dry-run",
      "--config",
      "apps/reporting-worker/wrangler.jsonc",
      "--outdir",
      workerOutputDirectory,
    ],
    { stdio: "pipe" },
  );
  assertRuntimeAppBoundary({ artifactRoots: [workerOutputDirectory] });
  console.log("Verified the Cloudflare Worker package with Wrangler dry-run bundling.");
} finally {
  rmSync(workerOutputDirectory, { recursive: true, force: true });
}

assertRuntimeAppBoundary();

function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
