import {
  APPROVED_GITHUB_REF,
  OWNER_GITHUB_USER_ID,
  parseApprovedWorkloadMapping,
  requireEnabledApprovedWorkloadMapping,
  type AllocationIdentity,
  type ApprovedBranchEvidence,
  type EnabledApprovedWorkloadMapping,
} from "@switchyard/core";

export const HEAD_SHA = "abcdef0123456789abcdef0123456789abcdef01";
export const REUSABLE_SHA = "123456789abcdef0123456789abcdef012345678";
export const RUN_ID = "81001";
export const CHECK_RUN_ID = "91001";
export const ALLOCATOR_JOB_ID = "92001";
export const CHECK_SUITE_ID = 71001;

export const IDENTITY: AllocationIdentity = {
  repository_id: "900000002",
  run_id: RUN_ID,
  run_attempt: 1,
  allocator_check_run_id: CHECK_RUN_ID,
};

export const ENABLED_MAPPING: EnabledApprovedWorkloadMapping =
  requireEnabledApprovedWorkloadMapping(
    parseApprovedWorkloadMapping({
      state: "enabled",
      mappingPointer: "example-workload/example-build",
      repository: {
        id: IDENTITY.repository_id,
        owner: "example-org",
        name: "example-workload",
      },
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
          commitSha: REUSABLE_SHA,
        },
      },
      workload: {
        backupChoice: "Keep going",
        blacksmithRunnerLabel: "blacksmith-4vcpu-ubuntu-2404",
        jobKey: "example-build",
        jobName: "Example approved build",
        profile: "linux-x64-large",
        timeoutMinutes: 25,
        production: true,
      },
    }),
  );

export const VALID_WORKFLOW = `name: Workload CI
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  owner-approval:
    name: Owner approval
    runs-on: ubuntu-latest
    steps:
      - run: echo approved
  allocate-example-build:
    name: Allocate example runner
    needs: owner-approval
    permissions:
      id-token: write
    uses: example-org/switchyard/.github/workflows/allocate-runner.yml@${REUSABLE_SHA}
    with:
      profile: linux-x64-large
      backupChoice: Keep going
  example-build:
    name: Example approved build
    needs: allocate-example-build
    runs-on: \${{ needs.allocate-example-build.outputs.runner_label }}
    timeout-minutes: 25
    steps:
      - run: npm test
`;

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function validRepository(): Record<string, unknown> {
  return {
    id: Number(IDENTITY.repository_id),
    full_name: "example-org/example-workload",
    private: true,
  };
}

export function validRunAttempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Number(RUN_ID),
    run_attempt: IDENTITY.run_attempt,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: HEAD_SHA,
    path: ".github/workflows/ci.yml",
    actor: { id: Number(OWNER_GITHUB_USER_ID) },
    triggering_actor: { id: Number(OWNER_GITHUB_USER_ID) },
    repository: { id: Number(IDENTITY.repository_id) },
    head_repository: { id: Number(IDENTITY.repository_id) },
    head_commit: { id: HEAD_SHA },
    pull_requests: [],
    check_suite_id: CHECK_SUITE_ID,
    ...overrides,
  };
}

export function validJobs(extraJobs: readonly unknown[] = []): Record<string, unknown> {
  const jobs = [
    {
      id: Number(ALLOCATOR_JOB_ID),
      run_id: Number(RUN_ID),
      head_sha: HEAD_SHA,
      name: ENABLED_MAPPING.allocator.checkName,
      check_run_url: `https://api.github.com/repos/example-org/example-workload/check-runs/${CHECK_RUN_ID}`,
      status: "in_progress",
    },
    ...extraJobs,
  ];
  return { total_count: jobs.length, jobs };
}

export function validGitRef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: APPROVED_GITHUB_REF,
    object: { type: "commit", sha: HEAD_SHA },
    ...overrides,
  };
}

export function validBranchEvidence(
  overrides: Partial<ApprovedBranchEvidence> = {},
): ApprovedBranchEvidence {
  return {
    kind: "approved-branch-evidence",
    repositoryId: IDENTITY.repository_id,
    runId: IDENTITY.run_id,
    approvedRunAttempt: 1,
    ref: APPROVED_GITHUB_REF,
    commitSha: HEAD_SHA,
    ...overrides,
  };
}

export function validAllocatorCheck(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: Number(CHECK_RUN_ID),
    head_sha: HEAD_SHA,
    name: ENABLED_MAPPING.allocator.checkName,
    app: { slug: "github-actions" },
    check_suite: { id: CHECK_SUITE_ID },
    status: "in_progress",
    conclusion: null,
    pull_requests: [],
    ...overrides,
  };
}
