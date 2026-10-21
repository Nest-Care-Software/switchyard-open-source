import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const templatePath = "infra/foundation/oidc-subject-correction.json";
const wrapperPath = "infra/foundation/update-oidc-subjects.sh";
const verifierPath = "infra/foundation/verify-oidc-subject-correction.mjs";
const template = JSON.parse(readFileSync(templatePath, "utf8"));
const engineSha = "5c9b286fcb5761a3fcf4b4c87882ec56103333e7";
const prefix =
  "repo:example-org@900000004/switchyard@900000003:ref:refs/heads/main:job_workflow_ref:example-org/switchyard";
const cliVersion = readFileSync("scripts/fixtures/azure-cli-2.89.1-cloud-shell.txt", "utf8");

const contracts = {
  bootstrap: {
    audience: "api://switchyard-900000003/infrastructure/bootstrap-applier",
    credential: "github-infrastructure-apply-engine",
    identity: "id-switchyard-infra-bootstrap-uksouth",
    subject: `${prefix}/.github/workflows/infrastructure-apply-engine.yml@${engineSha}`,
  },
  foundation: {
    audience: "api://switchyard-900000003/infrastructure/foundation-applier",
    credential: "github-infrastructure-apply-engine",
    identity: "id-switchyard-infra-foundation-uksouth",
    subject: `${prefix}/.github/workflows/infrastructure-apply-engine.yml@${engineSha}`,
  },
  planner: {
    audience: "api://switchyard-900000003/infrastructure/planner",
    credential: "github-infrastructure-plan-engine",
    identity: "id-switchyard-infra-planner-uksouth",
    subject: `${prefix}/.github/workflows/infrastructure-plan-engine.yml@${engineSha}`,
  },
};

describe("one-time live OIDC subject correction", () => {
  it("updates only the three exact existing federated credentials", () => {
    assert.equal(template.variables.expectedSubscriptionId, "a0000000-0000-4000-8000-000000000001");
    assert.equal(template.variables.expectedTenantId, "a0000000-0000-4000-8000-000000000002");
    assert.equal(template.variables.expectedResourceGroupName, "rg-switchyard-example-state");
    assert.equal(template.variables.finalEngineSha, engineSha);
    assert.equal(template.resources.length, 3);
    assert.ok(
      template.resources.every(
        (resource) =>
          resource.type ===
            "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials" &&
          resource.condition === "[variables('activationAllowed')]" &&
          resource.properties.issuer === "https://token.actions.githubusercontent.com",
      ),
    );
    assert.deepEqual(
      template.resources.map((resource) => resource.properties.audiences[0]).sort(),
      Object.values(contracts)
        .map((contract) => contract.audience)
        .sort(),
    );
    assert.equal(template.variables.subjectPrefix.includes(":context:"), false);
    assert.equal(template.variables.subjectPrefix.includes("%3A"), false);
    assert.match(template.variables.subjectPrefix, /:ref:refs\/heads\/main:job_workflow_ref:/);
    assert.deepEqual(Object.keys(template.outputs).sort(), [
      "applySubject",
      "corrected",
      "planSubject",
    ]);
  });

  it("verifies each exact live credential and rejects the former subject or broader audience", () => {
    for (const [kind, contract] of Object.entries(contracts)) {
      const fixture = credentialFixture(contract);
      const accepted = runVerifier(kind, fixture);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(accepted.stdout, "verified\n");
      for (const properties of [
        {
          ...fixture.properties,
          subject: fixture.properties.subject.replace(":ref:", ":context:ref%3A"),
        },
        { ...fixture.properties, audiences: [...fixture.properties.audiences, "api://broader"] },
      ]) {
        const rejected = runVerifier(kind, { ...fixture, properties });
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /does not match/);
      }
    }
    const oversized = spawnSync("node", [verifierPath, "planner"], {
      encoding: "utf8",
      input: "x".repeat(32 * 1024 + 1),
    });
    assert.notEqual(oversized.status, 0);
  });

  it("supports safe validation and acknowledgement-bound creation with exact rereads", () => {
    withFakeAzure(({ bin, log }) => {
      const validation = runWrapper(bin, ["validate"]);
      assert.equal(validation.status, 0, validation.stderr);
      assert.match(readFileSync(log, "utf8"), /deployment group validate/);

      writeFileSync(log, "");
      const digest = createHash("sha256").update(readFileSync(templatePath)).digest("hex");
      const creation = runWrapper(bin, ["create", `UPDATE SWITCHYARD OIDC SUBJECTS ${digest}`]);
      assert.equal(creation.status, 0, creation.stderr);
      assert.match(creation.stdout, /All three Switchyard federated credentials/);
      const calls = readFileSync(log, "utf8");
      assert.match(calls, /deployment group create/);
      assert.match(calls, /deployment group show/);
      assert.equal((calls.match(/^rest /gm) ?? []).length, 3);
    });
  });

  it("rejects a wrong acknowledgement before deployment", () => {
    withFakeAzure(({ bin, log }) => {
      const result = runWrapper(bin, ["create", "UPDATE SWITCHYARD OIDC SUBJECTS wrong"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Creation requires/);
      assert.equal(readOptional(log), "");
    });
  });
});

function credentialFixture(contract) {
  return {
    id:
      "/subscriptions/a0000000-0000-4000-8000-000000000001/resourceGroups/rg-switchyard-example-state" +
      `/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${contract.identity}` +
      `/federatedIdentityCredentials/${contract.credential}`,
    name: contract.credential,
    properties: {
      audiences: [contract.audience],
      issuer: "https://token.actions.githubusercontent.com",
      subject: contract.subject,
    },
    type: "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials",
  };
}

function runVerifier(kind, fixture) {
  return spawnSync("node", [verifierPath, kind], {
    encoding: "utf8",
    input: JSON.stringify(fixture),
  });
}

function runWrapper(fakeBin, arguments_) {
  return spawnSync("bash", [wrapperPath, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
  });
}

function withFakeAzure(work) {
  const directory = mkdtempSync(join(tmpdir(), "switchyard-oidc-subject-test-"));
  const bin = join(directory, "bin");
  const log = join(directory, "az.log");
  try {
    mkdirSync(bin);
    const az = join(bin, "az");
    writeFileSync(
      az,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  --version)
    printf '%s' ${shellQuote(cliVersion)} >&2
    ;;
  account)
    printf '{"id":"a0000000-0000-4000-8000-000000000001","tenantId":"a0000000-0000-4000-8000-000000000002"}\\n'
    ;;
  deployment)
    if [[ "$*" == *' group show '* ]]; then printf 'true\\n'; else printf '{}\\n'; fi
    ;;
  rest)
    if [[ "$*" == *'infra-planner'* ]]; then
      printf '%s\\n' ${shellQuote(JSON.stringify(credentialFixture(contracts.planner)))}
    elif [[ "$*" == *'infra-foundation'* ]]; then
      printf '%s\\n' ${shellQuote(JSON.stringify(credentialFixture(contracts.foundation)))}
    elif [[ "$*" == *'infra-bootstrap'* ]]; then
      printf '%s\\n' ${shellQuote(JSON.stringify(credentialFixture(contracts.bootstrap)))}
    else
      exit 64
    fi
    ;;
  *) exit 64 ;;
esac
`,
    );
    chmodSync(az, 0o755);
    work({ bin, log });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
