import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const bootstrap = readFileSync("infra/assets/azure-runner/bootstrap.sh", "utf8");
const contract =
  /# BEGIN SWITCHYARD TESTABLE IMDS CONTRACT\n(?<body>[\s\S]*?)\n# END SWITCHYARD TESTABLE IMDS CONTRACT/.exec(
    bootstrap,
  );
assert.ok(contract?.groups?.body, "testable bootstrap IMDS contract is missing");

const allocationId = `sy1-${"a".repeat(64)}`;
const digest = "a".repeat(64);
const valid = metadata();

test("the bootstrap accepts the exact immutable Azure deadline contract", () => {
  assert.equal(run(valid).status, 0);
});

for (const [name, mutate] of [
  ["duplicate tag", (value) => value.tagsList.push({ ...value.tagsList[0] })],
  [
    "case-ambiguous duplicate tag",
    (value) => value.tagsList.push({ name: "AllocationId", value: allocationId }),
  ],
  ["missing tag", (value) => value.tagsList.splice(findTag(value, "latestSafeStart"), 1)],
  ["wrong generation", (value) => setTag(value, "physicalGeneration", "2")],
  ["wrong managedBy value", (value) => setTag(value, "managedBy", "some-controller")],
  ["wrong lifetime", (value) => setTag(value, "allocationLifetimeMinutes", "90")],
  ["wrong timeout", (value) => setTag(value, "mappedJobTimeoutMinutes", "24")],
  ["wrong margin", (value) => setTag(value, "providerStopMarginMinutes", "6")],
  [
    "wrong latest-safe-start arithmetic",
    (value) => setTag(value, "latestSafeStart", "2026-08-25T10:11:00.000Z"),
  ],
  [
    "wrong CompleteBy arithmetic",
    (value) => setTag(value, "originalCompleteBy", "2026-08-25T10:39:59.999Z"),
  ],
  [
    "wrong deletion arithmetic",
    (value) => setTag(value, "deletionTarget", "2026-08-25T10:44:59.999Z"),
  ],
  [
    "wrong allocation group",
    (value) => (value.resourceGroupName = "rg-switchyard-example-control"),
  ],
  ["wrong VM", (value) => (value.name = "swy-unrelated-g1")],
]) {
  test(`the bootstrap rejects a ${name}`, () => {
    const fixture = structuredClone(valid);
    mutate(fixture);
    assert.equal(run(fixture).status, 70);
  });
}

function run(value) {
  const directory = mkdtempSync(join(tmpdir(), "switchyard-imds-contract-"));
  try {
    const metadataFile = join(directory, "metadata.json");
    writeFileSync(metadataFile, JSON.stringify(value));
    return spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail\nfail() { exit 70; }\nmetadata_file="$1"\n${contract.groups.body}\n`,
        "switchyard-imds-test",
        metadataFile,
      ],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function metadata() {
  const values = {
    allocationAcceptedAt: "2026-08-25T10:00:00.000Z",
    allocationId,
    allocationLifetimeMinutes: "45",
    deadlineContractValidated: "true",
    deletionTarget: "2026-08-25T10:45:00.000Z",
    latestSafeStart: "2026-08-25T10:10:00.000Z",
    managedBy: "switchyard-controller",
    mappedJobTimeoutMinutes: "25",
    originalCompleteBy: "2026-08-25T10:40:00.000Z",
    physicalGeneration: "1",
    physicalGenerationId: `${allocationId}:g1`,
    providerStopMarginMinutes: "5",
    system: "switchyard",
  };
  return {
    azEnvironment: "AZUREPUBLICCLOUD",
    location: "uksouth",
    name: `swy-${digest.slice(0, 20)}-g1`,
    resourceGroupName: `rg-switchyard-allocation-${digest.slice(0, 24)}`,
    tagsList: Object.entries(values).map(([name, value]) => ({ name, value })),
  };
}

function findTag(value, name) {
  const index = value.tagsList.findIndex((tag) => tag.name === name);
  assert.notEqual(index, -1);
  return index;
}

function setTag(value, name, replacement) {
  value.tagsList[findTag(value, name)].value = replacement;
}
