import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AllocationControlLedger,
  ApprovedBranchEvidenceStore,
  ReconcilerHeartbeatStore,
} from "../src/index.js";
import {
  createInitialisedInMemoryLedgerStore,
  InMemoryAllocationLedger,
  IN_MEMORY_LEDGER_SCHEMA_VERSION,
} from "../src/testing/index.js";

describe("authoritative storage capabilities", () => {
  it("supplies branch evidence independently from post-trust allocation control", () => {
    const evidence = {
      initialisedAt: "2026-08-25T00:00:00.000Z",
      ledgerInstanceId: "capability-split-test",
      schemaVersion: IN_MEMORY_LEDGER_SCHEMA_VERSION,
      utcDay: "2026-08-25",
    } as const;
    const implementation = new InMemoryAllocationLedger(
      createInitialisedInMemoryLedgerStore(evidence),
      evidence,
    );
    const branch: ApprovedBranchEvidenceStore = implementation;
    const control: AllocationControlLedger = implementation;
    const heartbeat: ReconcilerHeartbeatStore = implementation;
    assert.equal(typeof branch.recordInitial, "function");
    assert.equal(typeof control.acceptAllocation, "function");
    assert.equal(typeof heartbeat.getReconcilerHeartbeat, "function");

    // @ts-expect-error The application-facing trust store cannot reserve or read allocations.
    branch.reserveProviderAttempt;
    // @ts-expect-error Post-trust allocation control cannot record approved branch evidence.
    control.recordInitial;
    // @ts-expect-error Heartbeat storage cannot expose allocation counters.
    heartbeat.reserveProviderAttempt;
  });
});
