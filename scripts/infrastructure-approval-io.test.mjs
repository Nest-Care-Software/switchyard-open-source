import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const requestScript = "scripts/infrastructure-approval-request.mjs";
const resultScript = "scripts/infrastructure-approval-result.mjs";
const planDigest = "a".repeat(64);
const artifactDigest = "b".repeat(64);
const manifestDigest = "c".repeat(64);
const resultDigest = "d".repeat(64);
const receiptDigest = "e".repeat(64);
const initialStateWorkflowRef =
  "example-org/switchyard/.github/workflows/infrastructure-initialise-state.yml@refs/heads/main";
const initialStateAcknowledgement = "INITIALISE EMPTY SWITCHYARD STATE";

describe("infrastructure workflow CLI bridge", () => {
  it("creates only the exact bounded plan and apply requests", () => {
    const plan = request("plan", {
      SWITCHYARD_AUTHORITY_CLASS: "foundation",
      SWITCHYARD_JOB_CHECK_RUN_ID: "404",
    });
    assert.deepEqual(plan, {
      operation: "plan",
      authorityClass: "foundation",
      jobCheckRunId: "404",
    });

    const apply = request("apply-saved-plan", {
      SWITCHYARD_ARTIFACT_ID: "505",
      SWITCHYARD_COMMIT_SHA: "1".repeat(40),
      SWITCHYARD_DESTRUCTIVE_ACKNOWLEDGEMENT: `APPROVE DESTRUCTIVE PLAN ${planDigest}`,
      SWITCHYARD_JOB_CHECK_RUN_ID: "606",
      SWITCHYARD_PLAN_DIGEST: planDigest,
      SWITCHYARD_PLAN_RUN_ID: "707",
    });
    assert.deepEqual(apply, {
      operation: "apply-saved-plan",
      approvalInputsJson: JSON.stringify({
        artifact_id: "505",
        commit_sha: "1".repeat(40),
        destructive_acknowledgement: `APPROVE DESTRUCTIVE PLAN ${planDigest}`,
        plan_digest: planDigest,
        plan_run_id: "707",
      }),
      jobCheckRunId: "606",
    });
  });

  it("routes only the exact initial-state caller and sentinel through the pinned apply engine", () => {
    const environment = {
      GITHUB_WORKFLOW_REF: initialStateWorkflowRef,
      SWITCHYARD_ARTIFACT_ID: "1",
      SWITCHYARD_COMMIT_SHA: "1".repeat(40),
      SWITCHYARD_DESTRUCTIVE_ACKNOWLEDGEMENT: initialStateAcknowledgement,
      SWITCHYARD_JOB_CHECK_RUN_ID: "808",
      SWITCHYARD_PLAN_DIGEST: "0".repeat(64),
      SWITCHYARD_PLAN_RUN_ID: "1",
    };
    assert.deepEqual(request("apply-saved-plan", environment), {
      operation: "initialise-state",
      jobCheckRunId: "808",
    });

    for (const override of [
      {
        GITHUB_WORKFLOW_REF:
          "example-org/switchyard/.github/workflows/infrastructure-apply.yml@refs/heads/main",
      },
      { SWITCHYARD_DESTRUCTIVE_ACKNOWLEDGEMENT: "INITIALISE STATE" },
      { SWITCHYARD_PLAN_DIGEST: "1".repeat(64) },
      { SWITCHYARD_PLAN_RUN_ID: "2" },
    ]) {
      const result = spawnSync(process.execPath, [requestScript, "apply-saved-plan"], {
        encoding: "utf8",
        env: { ...process.env, ...environment, ...override },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /"status":"failed"/);
      assert.equal(result.stdout, "");
    }
  });

  it("rejects missing, malformed and oversized request values", () => {
    for (const [operation, environment] of [
      ["plan", { SWITCHYARD_AUTHORITY_CLASS: "other", SWITCHYARD_JOB_CHECK_RUN_ID: "404" }],
      ["plan", { SWITCHYARD_AUTHORITY_CLASS: "foundation" }],
      [
        "apply-saved-plan",
        {
          SWITCHYARD_ARTIFACT_ID: "505",
          SWITCHYARD_COMMIT_SHA: "1".repeat(40),
          SWITCHYARD_DESTRUCTIVE_ACKNOWLEDGEMENT: "yes",
          SWITCHYARD_JOB_CHECK_RUN_ID: "606",
          SWITCHYARD_PLAN_DIGEST: planDigest,
          SWITCHYARD_PLAN_RUN_ID: "707",
        },
      ],
    ]) {
      const result = spawnSync(process.execPath, [requestScript, operation], {
        encoding: "utf8",
        env: { ...process.env, ...environment },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /"status":"failed"/);
      assert.equal(result.stdout, "");
    }
  });

  it("publishes only validated plan outputs and a bounded review summary", () => {
    const directory = mkdtempSync(join(tmpdir(), "switchyard-workflow-result-"));
    const artifactPath = join(directory, "switchyard-plan-bundle.zip");
    const outputPath = join(directory, "output");
    const summaryPath = join(directory, "summary");
    writeFileSync(artifactPath, "bundle", { mode: 0o600 });
    writeFileSync(outputPath, "", { mode: 0o600 });
    writeFileSync(summaryPath, "", { mode: 0o600 });
    execFileSync(process.execPath, [resultScript, "plan"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      input: JSON.stringify({
        artifact_name: `switchyard-infrastructure-plan-${planDigest}`,
        artifact_path: artifactPath,
        artifact_sha256: artifactDigest,
        manifest_sha256: manifestDigest,
        plan_sha256: planDigest,
        status: "planned",
      }),
    });
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, new RegExp(`artifact_name=switchyard-infrastructure-plan-${planDigest}`));
    assert.match(output, new RegExp(`artifact_path=${artifactPath}`));
    assert.match(readFileSync(summaryPath, "utf8"), new RegExp(planDigest));
  });

  it("publishes only completed apply evidence and rejects extra fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "switchyard-workflow-apply-result-"));
    const outputPath = join(directory, "output");
    const summaryPath = join(directory, "summary");
    writeFileSync(outputPath, "", { mode: 0o600 });
    writeFileSync(summaryPath, "", { mode: 0o600 });
    const value = {
      plan_sha256: planDigest,
      receipt_sha256: receiptDigest,
      replayed: false,
      result_sha256: resultDigest,
      status: "completed",
    };
    execFileSync(process.execPath, [resultScript, "apply-saved-plan"], {
      env: { ...process.env, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath },
      input: JSON.stringify(value),
    });
    assert.match(readFileSync(outputPath, "utf8"), /status=completed/);
    const rejected = spawnSync(process.execPath, [resultScript, "apply-saved-plan"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath },
      input: JSON.stringify({ ...value, token: "forbidden" }),
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /infrastructure-result-keys-invalid/);
  });

  it("publishes only canonical initial-state evidence for the dedicated caller", () => {
    const directory = mkdtempSync(join(tmpdir(), "switchyard-workflow-state-result-"));
    const outputPath = join(directory, "output");
    const summaryPath = join(directory, "summary");
    writeFileSync(outputPath, "", { mode: 0o600 });
    writeFileSync(summaryPath, "", { mode: 0o600 });
    execFileSync(process.execPath, [resultScript, "apply-saved-plan"], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      input: JSON.stringify({
        backend_state_etag: '"state-etag"',
        backend_state_sha256: planDigest,
        lineage: "11111111-1111-4111-8111-111111111111",
        record_etag: '"record-etag"',
        serial: 0,
        status: "initialised",
      }),
    });
    assert.match(readFileSync(outputPath, "utf8"), /status=initialised/);
    assert.match(readFileSync(outputPath, "utf8"), /serial=0/);
    assert.doesNotMatch(readFileSync(outputPath, "utf8"), /etag/);
    assert.match(readFileSync(summaryPath, "utf8"), /State serial: `0`/);
  });
});

function request(operation, environment) {
  return JSON.parse(
    execFileSync(process.execPath, [requestScript, operation], {
      encoding: "utf8",
      env: { ...process.env, ...environment },
    }),
  );
}
