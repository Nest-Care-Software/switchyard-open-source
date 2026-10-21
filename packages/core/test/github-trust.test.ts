import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPROVED_GITHUB_REF,
  OWNER_GITHUB_USER_ID,
  parseApprovedWorkloadMapping,
  parseVerifiedWorkloadTrust,
  requireEnabledApprovedWorkloadMapping,
} from "../src/index.js";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

const WORKLOAD = {
  backupChoice: "Keep going",
  blacksmithRunnerLabel: "blacksmith-4vcpu-ubuntu-2404",
  jobKey: "example-build",
  jobName: "Example approved build",
  profile: "linux-x64-large",
  timeoutMinutes: 25,
  production: true,
} as const;

const REPOSITORY = {
  id: "900000002",
  owner: "example-org",
  name: "example-workload",
} as const;

const ENABLED_MAPPING = {
  state: "enabled",
  mappingPointer: "example-workload/example-build",
  repository: REPOSITORY,
  callerWorkflow: {
    path: ".github/workflows/ci.yml",
    ref: APPROVED_GITHUB_REF,
  },
  ownerActorId: OWNER_GITHUB_USER_ID,
  approvedCallerGateJobKey: "owner-approval",
  allocator: {
    jobKey: "allocate-example-build",
    jobName: "Allocate example runner",
    checkName: "Allocate example runner / allocate",
    reusableWorkflow: {
      repository: { owner: "example-org", name: "switchyard" },
      path: ".github/workflows/allocate-runner.yml",
      commitSha: COMMIT_SHA,
    },
  },
  workload: WORKLOAD,
} as const;

describe("approved GitHub workload mappings", () => {
  it("keeps the production pilot disabled without inventing allocator or reusable-workflow values", () => {
    const disabled = parseApprovedWorkloadMapping({
      state: "disabled",
      mappingPointer: "example-workload/example-build",
      reason: "Awaiting an approved allocator job/check and reusable workflow commit SHA",
      repository: REPOSITORY,
      callerWorkflow: {
        path: ".github/workflows/ci.yml",
        ref: APPROVED_GITHUB_REF,
      },
      ownerActorId: OWNER_GITHUB_USER_ID,
      workload: { ...WORKLOAD, jobName: null },
    });

    assert.equal(disabled.state, "disabled");
    assert.ok(!("allocator" in disabled));
    assert.equal(disabled.workload.jobName, null);
    assert.throws(() => requireEnabledApprovedWorkloadMapping(disabled), /mapping is disabled/);
  });

  it("accepts an enabled mapping only with a full immutable reusable workflow SHA", () => {
    const mapping = requireEnabledApprovedWorkloadMapping(
      parseApprovedWorkloadMapping(ENABLED_MAPPING),
    );

    assert.equal(mapping.allocator.reusableWorkflow.commitSha, COMMIT_SHA);
    assert.equal(mapping.callerWorkflow.ref, "refs/heads/main");
    assert.equal(mapping.workload.timeoutMinutes, 25);
  });

  it("rejects mutable reusable refs, timeout expressions and unknown mapping fields", () => {
    assert.throws(
      () =>
        parseApprovedWorkloadMapping({
          ...ENABLED_MAPPING,
          allocator: {
            ...ENABLED_MAPPING.allocator,
            reusableWorkflow: {
              ...ENABLED_MAPPING.allocator.reusableWorkflow,
              commitSha: "main",
            },
          },
        }),
      /full lowercase 40-character commit SHA/,
    );

    assert.throws(
      () =>
        parseApprovedWorkloadMapping({
          ...ENABLED_MAPPING,
          workload: { ...WORKLOAD, timeoutMinutes: `\${{ inputs.timeout }}` },
        }),
      /positive safe integer/,
    );

    assert.throws(
      () => parseApprovedWorkloadMapping({ ...ENABLED_MAPPING, provider: "azure" }),
      /unsupported field 'provider'/,
    );

    for (const workload of [
      { ...WORKLOAD, backupChoice: "Continue anyway" },
      { ...WORKLOAD, blacksmithRunnerLabel: "blacksmith label with spaces" },
    ]) {
      assert.throws(() => parseApprovedWorkloadMapping({ ...ENABLED_MAPPING, workload }));
    }
  });

  it("strictly validates adapter-produced trust evidence", () => {
    const evidence = parseVerifiedWorkloadTrust({
      identity: {
        repository_id: REPOSITORY.id,
        run_id: "101",
        run_attempt: 2,
        allocator_check_run_id: "303",
      },
      approvedBranch: {
        kind: "approved-branch-evidence",
        repositoryId: REPOSITORY.id,
        runId: "101",
        approvedRunAttempt: 1,
        ref: APPROVED_GITHUB_REF,
        commitSha: COMMIT_SHA,
      },
      mappingPointer: ENABLED_MAPPING.mappingPointer,
      repository: REPOSITORY,
      workflow: {
        path: ENABLED_MAPPING.callerWorkflow.path,
        commitSha: COMMIT_SHA,
      },
      ownerActorId: OWNER_GITHUB_USER_ID,
      allocator: {
        jobKey: ENABLED_MAPPING.allocator.jobKey,
        checkName: ENABLED_MAPPING.allocator.checkName,
        checkRunId: "303",
        jobId: "404",
        reusableWorkflow: ENABLED_MAPPING.allocator.reusableWorkflow,
      },
      workload: WORKLOAD,
    });

    assert.equal(evidence.identity.run_attempt, 2);
    assert.equal(evidence.approvedBranch.approvedRunAttempt, 1);
    assert.equal(evidence.allocator.jobId, "404");
    assert.deepEqual(
      evidence.allocator.reusableWorkflow,
      ENABLED_MAPPING.allocator.reusableWorkflow,
    );
    assert.throws(
      () => parseVerifiedWorkloadTrust({ ...evidence, provider: "blacksmith" }),
      /unsupported field 'provider'/,
    );
    assert.throws(
      () =>
        parseVerifiedWorkloadTrust({
          ...evidence,
          approvedBranch: { ...evidence.approvedBranch, runId: "999" },
        }),
      /does not match the allocation identity/,
    );

    assert.throws(() => parseVerifiedWorkloadTrust(Object.create(evidence)), /ordinary|own data/);
    let getterCalled = false;
    const accessor = { ...evidence } as Record<string, unknown>;
    Object.defineProperty(accessor, "mappingPointer", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return evidence.mappingPointer;
      },
    });
    assert.throws(() => parseVerifiedWorkloadTrust(accessor), /own data property/);
    assert.equal(getterCalled, false);

    const nullPrototype = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
    Object.setPrototypeOf(nullPrototype, null);
    assert.equal(parseVerifiedWorkloadTrust(nullPrototype).mappingPointer, evidence.mappingPointer);
  });
});
