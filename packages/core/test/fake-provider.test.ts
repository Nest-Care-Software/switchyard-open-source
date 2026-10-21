import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AzureAllocationSuccess,
  BlacksmithAllocationSuccess,
  ProviderAdapter,
  AzureProviderAllocationRequest,
  BlacksmithProviderAllocationRequest,
} from "../src/index.js";
import { FakeProviderAdapter } from "../src/testing/fake-provider.js";

// @ts-expect-error ProviderAdapter must always name its provider discriminator.
export type ProviderNeutralAdapterMustNotCompile = ProviderAdapter;

const AZURE_REQUEST: AzureProviderAllocationRequest = {
  allocationId: "allocation-123",
  identity: {
    repository_id: "987654321",
    run_id: "1234567890",
    run_attempt: 1,
    allocator_check_run_id: "555000111",
  },
  ordinal: 1,
  profile: "linux-x64-large",
  provider: "azure",
};

const BLACKSMITH_REQUEST: BlacksmithProviderAllocationRequest = {
  ...AZURE_REQUEST,
  approvedManagedLabel: {
    kind: "central-allowlist-match",
    profile: "linux-x64-large",
    runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
    timeoutMinutes: 25,
    workflowJobMappingPointer: "example-workload/quality-gates",
  },
  ordinal: 2,
  provider: "blacksmith",
};

describe("fake provider adapters", () => {
  it("returns queued ephemeral Azure results and records requests", async () => {
    const result: AzureAllocationSuccess = {
      outcome: "allocated",
      provider: "azure",
      runner: {
        kind: "ephemeral",
        labelScope: "unique-allocation",
        runnerLabel: "switchyard-allocation-123",
      },
    };
    const provider = new FakeProviderAdapter("azure", [result]);

    assert.deepEqual(await provider.allocate(AZURE_REQUEST), result);
    assert.deepEqual(provider.requests, [AZURE_REQUEST]);
  });

  it("returns queued managed-label Blacksmith results", async () => {
    const result: BlacksmithAllocationSuccess = {
      outcome: "allocated",
      provider: "blacksmith",
      runner: {
        kind: "managed-label",
        labelScope: "shared",
        runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
        authorisation: {
          workflowJobMappingPointer: "example-workload/quality-gates",
          profile: "linux-x64-large",
          timeoutMinutes: 25,
        },
      },
    };
    const provider = new FakeProviderAdapter("blacksmith", [result]);

    assert.deepEqual(await provider.allocate(BLACKSMITH_REQUEST), result);
    assert.equal(provider.runnerKind, "managed-label");
  });

  it("fails fast when a fake result does not match its adapter contract", async () => {
    const malformed = {
      outcome: "allocated",
      provider: "azure",
      runner: {
        kind: "managed-label",
        labelScope: "shared",
        runnerLabel: "wrong-kind",
        authorisation: {
          workflowJobMappingPointer: "example-workload/quality-gates",
          profile: "linux-x64-large",
          timeoutMinutes: 25,
        },
      },
    } as const;
    const provider = new FakeProviderAdapter("azure", [malformed]);

    await assert.rejects(() => provider.allocate(AZURE_REQUEST), /providerAttemptResult\.runner/);
  });

  it("rejects post-return correlation fields in a pre-return Blacksmith result", async () => {
    const malformed = {
      outcome: "allocated",
      provider: "blacksmith",
      runner: {
        kind: "managed-label",
        labelScope: "shared",
        runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
        authorisation: {
          workflowJobMappingPointer: "example-workload/quality-gates",
          profile: "linux-x64-large",
          timeoutMinutes: 25,
          persistedGitHubJobId: "99112233",
        },
      },
    } as const;
    const provider = new FakeProviderAdapter("blacksmith", [malformed]);

    await assert.rejects(
      () => provider.allocate(BLACKSMITH_REQUEST),
      /contains unsupported field 'persistedGitHubJobId'/,
    );
  });
});
