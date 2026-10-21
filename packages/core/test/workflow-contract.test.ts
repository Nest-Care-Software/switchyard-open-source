import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BACKUP_CHOICES,
  CAPABILITY_PROFILES,
  DEFAULT_BACKUP_CHOICE,
  parseWorkflowInputs,
  parseWorkflowOutputs,
  POST_JOB_VISIBILITY,
} from "../src/index.js";

describe("public reusable-workflow contract", () => {
  it("offers exactly the two V1 capability profiles and backup choices", () => {
    assert.deepEqual(CAPABILITY_PROFILES, ["linux-x64-standard", "linux-x64-large"]);
    assert.deepEqual(BACKUP_CHOICES, ["Keep going", "Save money"]);
  });

  it("requires a profile and defaults the backup choice to Keep going", () => {
    assert.deepEqual(parseWorkflowInputs({ profile: "linux-x64-large" }), {
      profile: "linux-x64-large",
      backupChoice: DEFAULT_BACKUP_CHOICE,
    });

    assert.deepEqual(
      parseWorkflowInputs({ profile: "linux-x64-standard", backupChoice: "Save money" }),
      {
        profile: "linux-x64-standard",
        backupChoice: "Save money",
      },
    );
  });

  it("rejects a missing or unsupported profile", () => {
    assert.throws(() => parseWorkflowInputs({}), /workflowInputs\.profile: is required/);
    assert.throws(
      () => parseWorkflowInputs({ profile: "Standard_D8ds_v6" }),
      /workflowInputs\.profile: must be one of/,
    );
  });

  it("rejects invalid backup choices and provider-specific inputs", () => {
    assert.throws(
      () => parseWorkflowInputs({ profile: "linux-x64-large", backupChoice: "Always Azure" }),
      /workflowInputs\.backupChoice: must be one of/,
    );
    assert.throws(
      () => parseWorkflowInputs({ profile: "linux-x64-large", provider: "azure" }),
      /workflowInputs: contains unsupported field 'provider'/,
    );
  });

  it("accepts only the runner label and allocation ID as outputs", () => {
    assert.deepEqual(
      parseWorkflowOutputs({ runner_label: "switchyard-123", allocation_id: "allocation-123" }),
      {
        runner_label: "switchyard-123",
        allocation_id: "allocation-123",
      },
    );

    assert.throws(
      () =>
        parseWorkflowOutputs({
          runner_label: "switchyard-123",
          allocation_id: "allocation-123",
          provider: "azure",
        }),
      /workflowOutputs: contains unsupported field 'provider'/,
    );
    assert.throws(
      () => parseWorkflowOutputs({ runner_label: "switchyard-123" }),
      /workflowOutputs\.allocation_id: is required/,
    );
    assert.throws(
      () =>
        parseWorkflowOutputs({
          runnerLabel: "switchyard-123",
          allocationId: "allocation-123",
        }),
      /workflowOutputs: contains unsupported field 'runnerLabel'/,
    );
  });

  it("uses a Switchyard Check Run for post-job visibility", () => {
    assert.equal(POST_JOB_VISIBILITY, "switchyard-check-run");
  });
});
