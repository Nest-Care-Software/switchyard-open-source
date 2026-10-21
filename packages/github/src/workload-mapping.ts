import {
  APPROVED_GITHUB_REF,
  OWNER_GITHUB_USER_ID,
  parseApprovedWorkloadMapping,
  type DisabledApprovedWorkloadMapping,
} from "@switchyard/core";

export const WORKLOAD_PRODUCTION_MAPPING = Object.freeze(
  parseApprovedWorkloadMapping({
    state: "disabled",
    mappingPointer: "example-workload/example-build",
    reason:
      "Awaiting the exact allocator job and Actions Check Run names and approved reusable Switchyard workflow commit SHA",
    repository: {
      id: "900000002",
      owner: "example-org",
      name: "example-workload",
    },
    callerWorkflow: {
      path: ".github/workflows/ci.yml",
      ref: APPROVED_GITHUB_REF,
    },
    ownerActorId: OWNER_GITHUB_USER_ID,
    workload: {
      backupChoice: "Keep going",
      blacksmithRunnerLabel: "blacksmith-4vcpu-ubuntu-2404",
      jobKey: "example-build",
      jobName: "Example approved build",
      profile: "linux-x64-large",
      timeoutMinutes: 25,
      production: true,
    },
  }) as DisabledApprovedWorkloadMapping,
);

export const PRODUCTION_APPROVED_WORKLOAD_MAPPINGS = Object.freeze([WORKLOAD_PRODUCTION_MAPPING]);
