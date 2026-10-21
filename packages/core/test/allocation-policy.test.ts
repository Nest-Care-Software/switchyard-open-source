import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideAllocationPolicy,
  PROVIDER_ORDER,
  type AllocationFailureClassification,
  type ApprovedManagedLabelMappingEvidence,
  type AzureAllocationSuccess,
  type ControllerHealthSnapshot,
  type ProviderAllocationFailure,
  type ProviderUnavailableReason,
} from "../src/index.js";

const HEALTHY_CONTROLLER: ControllerHealthSnapshot = {
  switchyardApi: "available",
  authoritativeLedger: "available",
  trustVerification: "verified",
  doppler: "available",
  reconciler: { lastSucceededAt: "2026-08-25T12:00:00.000Z" },
};
const NOW = new Date("2026-08-25T12:01:00.000Z");

const AZURE_SUCCESS: AzureAllocationSuccess = {
  outcome: "allocated",
  provider: "azure",
  runner: {
    kind: "ephemeral",
    labelScope: "unique-allocation",
    runnerLabel: "switchyard-allocation-123",
  },
};

const BLACKSMITH_SUCCESS = {
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
} as const;

const APPROVED_MAPPING: ApprovedManagedLabelMappingEvidence = {
  kind: "central-allowlist-match",
  workflowJobMappingPointer: "example-workload/quality-gates",
  profile: "linux-x64-large",
  runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
  timeoutMinutes: 25,
};

function azureUnavailable(reason: ProviderUnavailableReason): ProviderAllocationFailure<"azure"> {
  return {
    outcome: "failed",
    provider: "azure",
    failure: {
      classification: "provider-unavailable",
      unavailableReason: reason,
      code: `azure-${reason}`,
      message: `Azure returned ${reason}`,
    },
  };
}

function azureFailure(
  classification: Exclude<AllocationFailureClassification, "provider-unavailable">,
): ProviderAllocationFailure<"azure"> {
  return {
    outcome: "failed",
    provider: "azure",
    failure: {
      classification,
      code: `azure-${classification}`,
      message: `Azure returned ${classification}`,
    },
  };
}

function decide(
  attempts: readonly unknown[],
  options: {
    readonly approvedMappings?: unknown;
    readonly backupChoice?: unknown;
    readonly controllerHealth?: unknown;
    readonly profile?: unknown;
  } = {},
) {
  return decideAllocationPolicy({
    attempts,
    backupChoice: Object.hasOwn(options, "backupChoice") ? options.backupChoice : "Keep going",
    controllerHealth: options.controllerHealth ?? HEALTHY_CONTROLLER,
    profile: Object.hasOwn(options, "profile") ? options.profile : "linux-x64-large",
    now: NOW,
    approvedManagedLabelMappings: Object.hasOwn(options, "approvedMappings")
      ? options.approvedMappings
      : [APPROVED_MAPPING],
  });
}

describe("pure allocation policy", () => {
  it("always starts with Azure when every controller component is healthy", () => {
    assert.deepEqual(PROVIDER_ORDER, ["azure", "blacksmith"]);
    assert.deepEqual(decide([]), { action: "attempt-provider", provider: "azure" });
  });

  it("uses only an ephemeral unique-allocation Azure result", () => {
    assert.deepEqual(decide([AZURE_SUCCESS]), {
      action: "use-runner",
      allocation: AZURE_SUCCESS,
    });
  });

  it("tries Blacksmith only for Azure capacity or provisioning unavailability", () => {
    const reasons: readonly ProviderUnavailableReason[] = [
      "capacity-unavailable",
      "provisioning-unavailable",
    ];

    for (const reason of reasons) {
      assert.deepEqual(decide([azureUnavailable(reason)]), {
        action: "attempt-provider",
        provider: "blacksmith",
      });
    }
  });

  it("selects a shared Blacksmith label only when separate allowlist evidence matches", () => {
    assert.deepEqual(
      decide([azureUnavailable("capacity-unavailable"), BLACKSMITH_SUCCESS], {
        approvedMappings: [APPROVED_MAPPING],
      }),
      { action: "use-runner", allocation: BLACKSMITH_SUCCESS },
    );
  });

  it("validates the complete profile, label and timeout contract against central evidence", () => {
    for (const approvedMappings of [
      [],
      [
        {
          ...APPROVED_MAPPING,
          runnerLabel: "blacksmith-2vcpu-ubuntu-2404",
        },
      ],
      [
        {
          ...APPROVED_MAPPING,
          workflowJobMappingPointer: "another/workflow-job",
        },
      ],
      [{ ...APPROVED_MAPPING, profile: "linux-x64-standard" }],
      [{ ...APPROVED_MAPPING, timeoutMinutes: 30 }],
    ]) {
      const decision = decide([azureUnavailable("capacity-unavailable"), BLACKSMITH_SUCCESS], {
        approvedMappings,
      });

      assert.equal(decision.action, "stop");
      if (decision.action === "stop") {
        assert.equal(decision.source, "blacksmith");
        assert.equal(decision.failure.classification, "security-failure");
        assert.equal(decision.failure.code, "managed-label-mapping-not-approved");
      }
    }
  });

  it("fails closed when allowlist evidence is a malformed transport value", () => {
    const decision = decide([azureUnavailable("capacity-unavailable")], {
      approvedMappings: "unvalidated arbitrary string",
    });

    assert.equal(decision.action, "stop");
    if (decision.action === "stop") {
      assert.equal(decision.failure.classification, "unexpected-internal-error");
      assert.equal(decision.failure.code, "malformed-runtime-contract");
    }
  });

  it("requires allowlist evidence before issuing a Blacksmith attempt", () => {
    for (const approvedMappings of [
      undefined,
      [],
      [{ ...APPROVED_MAPPING, kind: "unrecognised-proof" }],
      [{ ...APPROVED_MAPPING, profile: "linux-x64-standard" }],
      [{ ...APPROVED_MAPPING, timeoutMinutes: 0 }],
      [{ ...APPROVED_MAPPING, timeoutMinutes: 1.5 }],
      [{ ...APPROVED_MAPPING, timeoutMinutes: "25" }],
    ]) {
      const decision = decide([azureUnavailable("capacity-unavailable")], {
        approvedMappings,
      });

      assert.equal(decision.action, "stop");
      if (decision.action === "stop") {
        assert.equal(decision.source, "blacksmith");
      }
    }
  });

  it("fails closed on malformed JavaScript provider result shapes", () => {
    const malformedAzureResults: readonly unknown[] = [
      {
        outcome: "allocated",
        provider: "azure",
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
      },
      {
        outcome: "allocated",
        provider: "azure",
        runner: {
          kind: "ephemeral",
          labelScope: "shared",
          runnerLabel: "switchyard-allocation-123",
        },
      },
      { outcome: "allocated", provider: "azure" },
      {
        outcome: "failed",
        provider: "azure",
        failure: {
          classification: "provider-unavailable",
          unavailableReason: "control-plane-unavailable",
          code: "wrong-reason",
          message: "not fallback eligible",
        },
      },
      { outcome: "mystery", provider: "azure" },
    ];

    const malformedBlacksmithResults: readonly unknown[] = [
      {
        outcome: "allocated",
        provider: "blacksmith",
        runner: {
          kind: "ephemeral",
          labelScope: "unique-allocation",
          runnerLabel: "switchyard-allocation-123",
        },
      },
      {
        ...BLACKSMITH_SUCCESS,
        runner: {
          ...BLACKSMITH_SUCCESS.runner,
          authorisation: {
            ...BLACKSMITH_SUCCESS.runner.authorisation,
            persistedGitHubJobId: "99112233",
          },
        },
      },
      {
        ...BLACKSMITH_SUCCESS,
        runner: {
          kind: "managed-label",
          labelScope: "shared",
          runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
        },
      },
      {
        ...BLACKSMITH_SUCCESS,
        runner: {
          ...BLACKSMITH_SUCCESS.runner,
          authorisation: {
            ...BLACKSMITH_SUCCESS.runner.authorisation,
            timeoutMinutes: 0,
          },
        },
      },
    ];

    for (const result of malformedAzureResults) {
      assertMalformedRuntimeDecision(decide([result]));
    }
    for (const result of malformedBlacksmithResults) {
      assertMalformedRuntimeDecision(decide([azureUnavailable("capacity-unavailable"), result]));
    }
  });

  it("fails closed before provider selection when controller health is malformed", () => {
    const decision = decide([azureUnavailable("capacity-unavailable")], {
      controllerHealth: { ...HEALTHY_CONTROLLER, doppler: "degraded" },
    });

    assert.equal(decision.action, "stop");
    if (decision.action === "stop") {
      assert.equal(decision.source, "controller");
      assert.equal(decision.failure.classification, "controller-unavailable");
    }
  });

  it("stops on Azure unavailability when the choice is Save money", () => {
    const unavailable = azureUnavailable("capacity-unavailable");
    const decision = decide([unavailable], { backupChoice: "Save money" });

    assert.equal(decision.action, "stop");
    if (decision.action === "stop") {
      assert.equal(decision.source, "azure");
      assert.deepEqual(decision.failure, unavailable.failure);
    }
  });

  it("never treats an unknown or missing backup choice as Keep going", () => {
    for (const backupChoice of [undefined, "Unknown choice"]) {
      const decision = decide([azureUnavailable("capacity-unavailable")], { backupChoice });

      assert.equal(decision.action, "stop");
      if (decision.action === "stop") {
        assert.equal(decision.source, "controller");
        assert.equal(decision.failure.classification, "invalid-configuration");
        assert.equal(decision.failure.code, "invalid-backup-choice");
      }
    }
  });

  it("fails closed when the requested capability profile is unknown or missing", () => {
    for (const profile of [undefined, "linux-x64-speculative"]) {
      const decision = decide([azureUnavailable("capacity-unavailable")], { profile });

      assert.equal(decision.action, "stop");
      if (decision.action === "stop") {
        assert.equal(decision.source, "controller");
        assert.equal(decision.failure.classification, "invalid-configuration");
        assert.equal(decision.failure.code, "invalid-profile");
      }
    }
  });

  it("never hides controller, configuration, security or internal failures with fallback", () => {
    const classifications: readonly Exclude<
      AllocationFailureClassification,
      "provider-unavailable"
    >[] = [
      "controller-unavailable",
      "invalid-configuration",
      "security-failure",
      "unexpected-internal-error",
    ];

    for (const classification of classifications) {
      const decision = decide([azureFailure(classification)]);
      assert.equal(decision.action, "stop");
      if (decision.action === "stop") {
        assert.equal(decision.failure.classification, classification);
      }
    }
  });

  it("stops when the final provider is unavailable", () => {
    const blacksmithUnavailable: ProviderAllocationFailure<"blacksmith"> = {
      outcome: "failed",
      provider: "blacksmith",
      failure: {
        classification: "provider-unavailable",
        unavailableReason: "capacity-unavailable",
        code: "daily-allowance",
        message: "Blacksmith daily allowance is exhausted",
      },
    };

    const decision = decide([azureUnavailable("capacity-unavailable"), blacksmithUnavailable]);

    assert.equal(decision.action, "stop");
    if (decision.action === "stop") {
      assert.equal(decision.source, "blacksmith");
      assert.deepEqual(decision.failure, blacksmithUnavailable.failure);
    }
  });

  it("stops with an internal error when attempt history violates provider order", () => {
    const decision = decide([BLACKSMITH_SUCCESS], { approvedMappings: [APPROVED_MAPPING] });

    assert.equal(decision.action, "stop");
    if (decision.action === "stop") {
      assert.equal(decision.failure.classification, "unexpected-internal-error");
      assert.equal(decision.failure.code, "invalid-policy-history");
    }
  });
});

function assertMalformedRuntimeDecision(decision: ReturnType<typeof decide>): void {
  assert.equal(decision.action, "stop");
  if (decision.action === "stop") {
    assert.equal(decision.failure.classification, "unexpected-internal-error");
    assert.equal(decision.failure.code, "malformed-runtime-contract");
  }
}
