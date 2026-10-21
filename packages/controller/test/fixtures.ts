import type { AllocationIdentity, BackupChoice, VerifiedWorkloadTrust } from "@switchyard/core";
import {
  createInitialisedInMemoryLedgerStore,
  InMemoryAllocationLedger,
  IN_MEMORY_LEDGER_SCHEMA_VERSION,
} from "@switchyard/core/testing";

import type { VerifiedAllocationRequestSecurityDecision } from "../src/index.js";

export const NOW = "2026-08-25T12:00:00.000Z";
export const CALLER_SHA = "abcdef0123456789abcdef0123456789abcdef01";
export const REUSABLE_SHA = "123456789abcdef0123456789abcdef012345678";
export const IDENTITY: AllocationIdentity = {
  allocator_check_run_id: "91001",
  repository_id: "900000002",
  run_attempt: 1,
  run_id: "81001",
};

export function verifiedTrust(backupChoice: BackupChoice = "Keep going"): VerifiedWorkloadTrust {
  return {
    approvedBranch: {
      approvedRunAttempt: 1,
      commitSha: CALLER_SHA,
      kind: "approved-branch-evidence",
      ref: "refs/heads/main",
      repositoryId: IDENTITY.repository_id,
      runId: IDENTITY.run_id,
    },
    allocator: {
      checkName: "Allocate example runner / allocate",
      checkRunId: IDENTITY.allocator_check_run_id,
      jobId: "92001",
      jobKey: "allocate-example-build",
      reusableWorkflow: {
        commitSha: REUSABLE_SHA,
        path: ".github/workflows/allocate-runner.yml",
        repository: { name: "switchyard", owner: "example-org" },
      },
    },
    identity: IDENTITY,
    mappingPointer: "example-workload/example-build",
    ownerActorId: "900000001",
    repository: {
      id: IDENTITY.repository_id,
      name: "example-workload",
      owner: "example-org",
    },
    workload: {
      backupChoice,
      blacksmithRunnerLabel: "blacksmith-4vcpu-ubuntu-2404",
      jobKey: "example-build",
      jobName: "Example approved build",
      production: true,
      profile: "linux-x64-large",
      timeoutMinutes: 25,
    },
    workflow: { commitSha: CALLER_SHA, path: ".github/workflows/ci.yml" },
  };
}

export function securityDecision(
  backupChoice: BackupChoice = "Keep going",
): VerifiedAllocationRequestSecurityDecision {
  const trust = verifiedTrust(backupChoice);
  return {
    entra: {
      apiAudience: "api://switchyard-control",
      clientApplicationId: "client-id",
      dedicatedRole: "Switchyard.Allocate",
      tenantId: "tenant-id",
    },
    github: {
      actorId: "900000001",
      callerWorkflowRef: "example-org/example-workload/.github/workflows/ci.yml@refs/heads/main",
      callerWorkflowSha: CALLER_SHA,
      identity: IDENTITY,
      issuedAt: NOW,
      jobWorkflowRef: `example-org/switchyard/.github/workflows/allocate-runner.yml@${REUSABLE_SHA}`,
      jobWorkflowSha: REUSABLE_SHA,
      ref: "refs/heads/main",
      repository: "example-org/example-workload",
      repositoryOwnerId: "12345678",
      sha: CALLER_SHA,
    },
    policyInput: {
      backupChoice,
      blacksmithRunnerLabel: trust.workload.blacksmithRunnerLabel,
      identity: IDENTITY,
      profile: trust.workload.profile,
      timeoutMinutes: trust.workload.timeoutMinutes,
    },
    trust,
  };
}

export function requestBody(backupChoice: BackupChoice = "Keep going"): string {
  return JSON.stringify({
    identity: IDENTITY,
    profile: "linux-x64-large",
    backupChoice,
  });
}

export function initialisedLedger(): InMemoryAllocationLedger {
  const evidence = {
    initialisedAt: "2026-08-25T00:00:00.000Z",
    ledgerInstanceId: `controller-test-${crypto.randomUUID()}`,
    schemaVersion: IN_MEMORY_LEDGER_SCHEMA_VERSION,
    utcDay: "2026-08-25",
  } as const;
  return new InMemoryAllocationLedger(createInitialisedInMemoryLedgerStore(evidence), evidence);
}
