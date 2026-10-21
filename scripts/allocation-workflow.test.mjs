import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import { parseDocument } from "yaml";

const path = ".github/workflows/allocate-runner.yml";
const actionManifestPath = ".github/actions/allocate/reviewed-source.json";
const safeActionCommit = "962f025fba27840b60e0fc06c5b5a7160451e82d";
const actionReference = `example-org/switchyard/.github/actions/allocate@${safeActionCommit}`;
const source = readFileSync(path, "utf8");
const document = parseDocument(source, { schema: "core", uniqueKeys: true });
if (document.errors.length !== 0) throw document.errors[0];
const workflow = document.toJS();
const expression = (value) => `$${`{{ ${value} }}`}`;

describe("organisation allocation reusable workflow", () => {
  it("exposes exactly the public two-input and two-output contract", () => {
    assert.deepEqual(Object.keys(workflow), ["name", "on", "permissions", "jobs"]);
    assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
    const call = workflow.on.workflow_call;
    assert.deepEqual(Object.keys(call), ["inputs", "outputs"]);
    assert.deepEqual(call.inputs, {
      profile: {
        description: "Approved Switchyard capability profile",
        required: true,
        type: "string",
      },
      backupChoice: {
        default: "Keep going",
        description: "Continue with the approved managed backup when Azure is unavailable",
        required: false,
        type: "string",
      },
    });
    assert.deepEqual(call.outputs, {
      runner_label: {
        description: "Provider-appropriate runner label",
        value: expression("jobs.allocate.outputs.runner_label"),
      },
      allocation_id: {
        description: "Switchyard allocation identifier",
        value: expression("jobs.allocate.outputs.allocation_id"),
      },
    });
  });

  it("uses only one bounded GitHub-hosted allocator job with minimum permissions", () => {
    assert.deepEqual(workflow.permissions, { "id-token": "write" });
    assert.deepEqual(Object.keys(workflow.jobs), ["allocate"]);
    const job = workflow.jobs.allocate;
    assert.deepEqual(Object.keys(job), ["name", "runs-on", "timeout-minutes", "outputs", "steps"]);
    assert.equal(job["runs-on"], "ubuntu-24.04");
    assert.equal(job["timeout-minutes"], 15);
    assert.equal(job.permissions, undefined);
    assert.deepEqual(job.outputs, {
      runner_label: expression("steps.allocate.outputs.runner_label"),
      allocation_id: expression("steps.allocate.outputs.allocation_id"),
    });
    assert.equal(job.steps.length, 2);
    assert.equal(source.includes("actions/checkout"), false);
    assert.equal(source.includes("actions/setup-node"), false);
    assert.equal(source.includes("secrets."), false);
    assert.equal(source.includes("github.token"), false);
    assert.equal(source.includes("GITHUB_TOKEN"), false);
    assert.equal(source.includes("blacksmith-"), false);
  });

  it("pins the private allocation action to reviewed source bytes", () => {
    const allocate = workflow.jobs.allocate.steps.find((step) => step.id === "allocate");
    assert.ok(allocate);
    assert.deepEqual(Object.keys(allocate), ["name", "id", "uses", "env"]);
    assert.equal(allocate.uses, actionReference);
    assert.match(allocate.uses, /^[^@]+@[0-9a-f]{40}$/);
    assert.equal(allocate.run, undefined);
    assert.equal(allocate.with, undefined);

    const manifest = JSON.parse(readFileSync(actionManifestPath, "utf8"));
    assert.deepEqual(Object.keys(manifest), ["commitSha", "files"]);
    assert.equal(manifest.commitSha, safeActionCommit);
    assert.deepEqual(Object.keys(manifest.files), [
      ".github/actions/allocate/action.yml",
      ".github/actions/allocate/index.mjs",
    ]);
    for (const [file, digest] of Object.entries(manifest.files)) {
      assert.match(digest, /^[0-9a-f]{64}$/);
      assert.equal(sha256(readFileSync(file)), digest, `${file} differs from the reviewed source`);
      const reviewedBytes = execFileSync("git", ["show", `${safeActionCommit}:${file}`]);
      assert.equal(sha256(reviewedBytes), digest, `${file} does not match the pinned commit`);
    }
  });

  it("binds the called workflow identity and exact allocation identity", () => {
    const [identityStep, allocate] = workflow.jobs.allocate.steps;
    assert.deepEqual(Object.keys(identityStep), ["name", "shell", "env", "run"]);
    assert.equal(identityStep.shell, "bash");
    assert.deepEqual(identityStep.env, {
      CALLED_WORKFLOW_FILE_PATH: expression("job.workflow_file_path"),
      CALLED_WORKFLOW_REF: expression("job.workflow_ref"),
      CALLED_WORKFLOW_REPOSITORY: expression("job.workflow_repository"),
      CALLED_WORKFLOW_SHA: expression("job.workflow_sha"),
    });
    assert.ok(allocate);
    assert.deepEqual(Object.keys(allocate.env), [
      "SWITCHYARD_ALLOCATION_PROOF_AUDIENCE",
      "SWITCHYARD_ALLOCATOR_CHECK_RUN_ID",
      "SWITCHYARD_API_AUDIENCE",
      "SWITCHYARD_API_URL",
      "SWITCHYARD_BACKUP_CHOICE",
      "SWITCHYARD_ENTRA_ASSERTION_AUDIENCE",
      "SWITCHYARD_ENTRA_CLIENT_ID",
      "SWITCHYARD_ENTRA_TENANT_ID",
      "SWITCHYARD_PROFILE",
      "SWITCHYARD_REPOSITORY_ID",
      "SWITCHYARD_RUN_ATTEMPT",
      "SWITCHYARD_RUN_ID",
    ]);
    assert.equal(allocate.env.SWITCHYARD_ENTRA_ASSERTION_AUDIENCE, "api://AzureADTokenExchange");
    assert.equal(allocate.env.SWITCHYARD_ALLOCATOR_CHECK_RUN_ID, expression("job.check_run_id"));
    for (const name of [
      "SWITCHYARD_ENTRA_TENANT_ID",
      "SWITCHYARD_ENTRA_CLIENT_ID",
      "SWITCHYARD_API_AUDIENCE",
      "SWITCHYARD_API_URL",
      "SWITCHYARD_ALLOCATION_PROOF_AUDIENCE",
    ]) {
      assert.match(allocate.env[name], /^\$\{\{ vars\.[A-Z0-9_]+ }}$/);
    }
  });

  it("uses called-workflow identity only in the three reviewed reusable workflows", () => {
    const workflowFiles = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name) => `.github/workflows/${name}`);
    const consumers = workflowFiles.filter((file) =>
      /job\.workflow_(file_path|ref|repository|sha)/.test(readFileSync(file, "utf8")),
    );
    assert.deepEqual(consumers, [
      path,
      ".github/workflows/infrastructure-apply-engine.yml",
      ".github/workflows/infrastructure-plan-engine.yml",
    ]);
    assert.equal([...source.matchAll(/job\.workflow_(file_path|ref|repository|sha)/g)].length, 4);
  });
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
