import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalUsageRecordJson,
  createUsageRecordContract,
  parseUsageRecord,
  USAGE_RECORD_KEYS,
  V1_APPROVED_REPORTING_DIMENSIONS,
  type ApprovedReportingDimensions,
} from "../src/index.js";
import { usageRecord } from "./fixture.js";

describe("strict usage record schema", () => {
  it("accepts exactly the reporting allowlist and produces stable canonical JSON", () => {
    const record = usageRecord();

    assert.deepEqual(Object.keys(record), USAGE_RECORD_KEYS);
    assert.deepEqual(JSON.parse(canonicalUsageRecordJson(record)), record);
    assert.deepEqual(V1_APPROVED_REPORTING_DIMENSIONS, [
      {
        repository: "example-org/example-workload",
        workflow: ".github/workflows/ci.yml",
        job: "example-build",
      },
    ]);
    assert.equal(Object.isFrozen(V1_APPROVED_REPORTING_DIMENSIONS), true);
    assert.equal(Object.isFrozen(V1_APPROVED_REPORTING_DIMENSIONS[0]), true);
  });

  it("rejects every missing allowlisted field", () => {
    const valid = usageRecord() as unknown as Record<string, unknown>;
    for (const key of USAGE_RECORD_KEYS) {
      const missing = { ...valid };
      delete missing[key];
      assert.throws(
        () => parseUsageRecord(missing),
        new RegExp(`usageRecord\\.${key}: is required`),
      );
    }
  });

  it("rejects machine, branch, actor, log, source, message, secret and all unknown fields", () => {
    const forbiddenFields = [
      "machine_sku",
      "machine_type",
      "branch",
      "actor",
      "actor_id",
      "logs",
      "runner_logs",
      "source",
      "source_code",
      "message",
      "commit_message",
      "secret",
      "token",
      "unexpected",
    ];

    for (const field of forbiddenFields) {
      assert.throws(
        () => parseUsageRecord({ ...usageRecord(), [field]: "must not be stored" }),
        new RegExp(`contains unsupported field '${field}'`),
        field,
      );
    }
  });

  it("rejects sensitive or SQL-shaped text even when it uses otherwise safe characters", () => {
    const adversarialDimensions = [
      { repository: "example-org/customer-password" },
      { repository: "example-org/example-workload-logs" },
      { workflow: ".github/workflows/production-secret.yml" },
      { workflow: ".github/workflows/customer-message.yml" },
      { job: "DROP_TABLE_usage_records" },
      { job: "runner_log_access_token" },
      { job: "example-build-secret" },
    ];

    for (const dimensions of adversarialDimensions) {
      assert.throws(
        () => parseUsageRecord({ ...usageRecord(), ...dimensions }),
        /must exactly match one centrally approved combination/,
      );
    }
  });

  it("matches injected immutable approvals as whole tuples and rejects mixed combinations", () => {
    const workload = {
      repository: "example-org/example-workload",
      workflow: ".github/workflows/ci.yml",
      job: "example-build",
    };
    const switchyard = {
      repository: "example-org/Switchyard",
      workflow: ".github/workflows/reporting.yml",
      job: "weekly-report",
    };
    const mutableApprovals = [workload, switchyard];
    const contract = createUsageRecordContract(mutableApprovals);
    const secondRecord = {
      ...usageRecord(),
      ...switchyard,
      github_run_url: "https://github.com/example-org/Switchyard/actions/runs/1234567890",
    };

    assert.deepEqual(contract.parse(secondRecord).job, "weekly-report");
    for (const mixed of [
      { ...usageRecord(), workflow: switchyard.workflow },
      { ...secondRecord, repository: workload.repository },
      { ...secondRecord, job: workload.job },
    ]) {
      assert.throws(
        () => contract.parse(mixed),
        /must exactly match one centrally approved combination/,
      );
    }

    workload.job = "mutated-after-injection";
    mutableApprovals.splice(0, mutableApprovals.length);
    assert.equal(contract.approvedDimensions.length, 2);
    assert.equal(contract.parse(usageRecord()).job, "example-build");
    assert.equal(Object.isFrozen(contract.approvedDimensions), true);
    assert.equal(Object.isFrozen(contract.approvedDimensions[0]), true);
  });

  it("rejects malformed, duplicated or metadata-bearing central approvals", () => {
    assert.throws(() => createUsageRecordContract([]), /at least one combination/);
    assert.throws(
      () =>
        createUsageRecordContract([
          V1_APPROVED_REPORTING_DIMENSIONS[0],
          V1_APPROVED_REPORTING_DIMENSIONS[0],
        ] as readonly ApprovedReportingDimensions[]),
      /duplicates/,
    );
    assert.throws(() =>
      createUsageRecordContract([
        { ...V1_APPROVED_REPORTING_DIMENSIONS[0], secret: "not configuration" },
      ] as unknown as readonly ApprovedReportingDimensions[]),
    );
  });

  it("binds the GitHub URL to its repository and decimal run ID", () => {
    assert.throws(() =>
      parseUsageRecord({
        ...usageRecord(),
        github_run_url: "https://example.com/example-org/example-workload/actions/runs/1234567890",
      }),
    );
    assert.throws(() =>
      parseUsageRecord({
        ...usageRecord(),
        github_run_url: "https://github.com/example-org/Other/actions/runs/1234567890",
      }),
    );
    assert.throws(() =>
      parseUsageRecord({
        ...usageRecord(),
        github_run_url: "https://github.com/example-org/example-workload/actions/runs/999",
      }),
    );
    assert.throws(() => parseUsageRecord({ ...usageRecord(), github_run_id: "1 OR 1=1" }));
  });

  it("requires canonical UTC timestamps and their exact measured duration", () => {
    assert.throws(() => parseUsageRecord({ ...usageRecord(), completed_at: "2026-08-24" }));
    assert.throws(() =>
      parseUsageRecord({ ...usageRecord(), completed_at: "2026-08-24T10:05:00.000+00:00" }),
    );
    assert.throws(() =>
      parseUsageRecord({ ...usageRecord(), completed_at: "2026-02-30T10:05:00.000Z" }),
    );
    assert.throws(() => parseUsageRecord({ ...usageRecord(), duration_ms: 299_999 }));
    assert.throws(() =>
      parseUsageRecord({
        ...usageRecord(),
        completed_at: "2026-08-24T09:59:59.999Z",
        duration_ms: 0,
      }),
    );
  });

  it("accepts only fixed providers, profiles, outcomes, booleans and safe integer costs", () => {
    for (const malformed of [
      { provider: "gcp" },
      { capability_profile: "Standard_D8ds_v6" },
      { outcome: "unknown" },
      { fallback_used: 1 },
      { cleanup_problem: "false" },
      { estimated_cost_usd_cents: -1 },
      { estimated_cost_usd_cents: 1.5 },
    ]) {
      assert.throws(() => parseUsageRecord({ ...usageRecord(), ...malformed }));
    }
  });

  it("requires the V1 fallback indicator to match the provider", () => {
    assert.throws(() => parseUsageRecord({ ...usageRecord(), fallback_used: true }));
    assert.deepEqual(
      parseUsageRecord({ ...usageRecord(), provider: "blacksmith", fallback_used: true }).provider,
      "blacksmith",
    );
  });
});
