import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPROVED_GITHUB_REF,
  OWNER_GITHUB_USER_ID,
  type ApprovedBranchEvidence,
  type EnabledApprovedWorkloadMapping,
} from "@switchyard/core";

import {
  GitHubRequestError,
  GitHubTrustVerifier,
  WORKLOAD_PRODUCTION_MAPPING,
  type WorkloadGitHubClientProvider,
} from "../src/index.js";
import {
  FakeApprovedBranchEvidenceStore,
  FakeWorkloadGitHubClient,
  FakeWorkloadGitHubClientProvider,
} from "../src/testing/fakes.js";
import {
  ALLOCATOR_JOB_ID,
  CHECK_RUN_ID,
  ENABLED_MAPPING,
  HEAD_SHA,
  IDENTITY,
  RUN_ID,
  utf8,
  validBranchEvidence,
  validAllocatorCheck,
  validGitRef,
  validJobs,
  validRepository,
  validRunAttempt,
  VALID_WORKFLOW,
} from "./fixtures.js";

interface EvidenceOverrides {
  readonly branchEvidence?: readonly ApprovedBranchEvidence[];
  readonly check?: unknown;
  readonly commit?: unknown;
  readonly gitRef?: unknown;
  readonly jobs?: unknown;
  readonly repository?: unknown;
  readonly run?: unknown;
  readonly workflow?: Uint8Array;
}

describe("GitHub trust verifier", () => {
  it("requires an authoritative approved branch evidence store", () => {
    assert.throws(
      () =>
        new GitHubTrustVerifier({
          approvedMappings: [ENABLED_MAPPING],
          branchEvidence: undefined as never,
          clients: new FakeWorkloadGitHubClientProvider(new FakeWorkloadGitHubClient()),
        }),
      /authoritative approved branch evidence store is required/,
    );
  });

  it("independently verifies the exact immutable run, allocator check and mapped workflow", async () => {
    const extraAllocator = {
      id: 91002,
      run_id: Number(RUN_ID),
      head_sha: HEAD_SHA,
      name: "Allocate another approved job / allocate",
      check_run_url: "https://api.github.com/repos/example-org/example-workload/check-runs/91002",
      status: "in_progress",
    };
    const { verifier, client } = verifierWith({ jobs: validJobs([extraAllocator]) });

    const result = await verifier.verify(IDENTITY);

    assert.equal(result.trusted, true);
    if (result.trusted) {
      assert.equal(result.evidence.identity.allocator_check_run_id, CHECK_RUN_ID);
      assert.equal(result.evidence.workflow.commitSha, HEAD_SHA);
      assert.equal(result.evidence.approvedBranch.ref, APPROVED_GITHUB_REF);
      assert.equal(result.evidence.allocator.jobId, ALLOCATOR_JOB_ID);
      assert.equal(result.evidence.workload.timeoutMinutes, 25);
    }
    assert.deepEqual(
      client.requests.map(({ operation }) => operation).sort(),
      [
        "getCheckRun",
        "getCommit",
        "getGitRef",
        "getRepository",
        "getWorkflowBytes",
        "getWorkflowRunAttempt",
        "listJobsForWorkflowRunAttempt",
      ].sort(),
    );
  });

  it("re-verifies an exact transport retry without changing allocation identity", async () => {
    const client = new FakeWorkloadGitHubClient({
      getRepository: [validRepository(), validRepository()],
      getWorkflowRunAttempt: [validRunAttempt(), validRunAttempt()],
      getGitRef: [validGitRef(), validGitRef()],
      listJobsForWorkflowRunAttempt: [validJobs(), validJobs()],
      getCheckRun: [validAllocatorCheck(), validAllocatorCheck()],
      getCommit: [{ sha: HEAD_SHA }, { sha: HEAD_SHA }],
      getWorkflowBytes: [utf8(VALID_WORKFLOW), utf8(VALID_WORKFLOW)],
    });
    const provider = new FakeWorkloadGitHubClientProvider(client);
    const branchEvidence = new FakeApprovedBranchEvidenceStore();
    const verifier = new GitHubTrustVerifier({
      approvedMappings: [ENABLED_MAPPING],
      branchEvidence,
      clients: provider,
    });

    const first = await verifier.verify(IDENTITY);
    const retry = await verifier.verify(IDENTITY);

    assert.equal(first.trusted, true);
    assert.deepEqual(retry, first);
    assert.equal(provider.calls, 2);
    assert.equal(branchEvidence.records.length, 2);
  });

  it("uses persisted initial branch evidence for a rerun after main has moved", async () => {
    const rerunIdentity = {
      ...IDENTITY,
      run_attempt: 2,
      allocator_check_run_id: "91002",
    };
    const rerunJobId = 92002;
    const client = new FakeWorkloadGitHubClient({
      getRepository: [validRepository()],
      getWorkflowRunAttempt: [validRunAttempt({ run_attempt: 2 })],
      getGitRef: [
        validGitRef({
          object: { type: "commit", sha: "fedcba9876543210fedcba9876543210fedcba98" },
        }),
      ],
      listJobsForWorkflowRunAttempt: [
        {
          total_count: 1,
          jobs: [
            {
              id: rerunJobId,
              run_id: Number(RUN_ID),
              head_sha: HEAD_SHA,
              name: ENABLED_MAPPING.allocator.checkName,
              check_run_url:
                "https://api.github.com/repos/example-org/example-workload/check-runs/91002",
              status: "in_progress",
            },
          ],
        },
      ],
      getCheckRun: [validAllocatorCheck({ id: 91002 })],
      getCommit: [{ sha: HEAD_SHA }],
      getWorkflowBytes: [utf8(VALID_WORKFLOW)],
    });
    const branchEvidence = new FakeApprovedBranchEvidenceStore([validBranchEvidence()]);
    const verifier = new GitHubTrustVerifier({
      approvedMappings: [ENABLED_MAPPING],
      branchEvidence,
      clients: new FakeWorkloadGitHubClientProvider(client),
    });

    const result = await verifier.verify(rerunIdentity);

    assert.equal(result.trusted, true);
    if (result.trusted) {
      assert.equal(result.evidence.approvedBranch.commitSha, HEAD_SHA);
      assert.equal(result.evidence.allocator.jobId, String(rerunJobId));
    }
    assert.equal(
      client.requests.some(({ operation }) => operation === "getGitRef"),
      false,
    );
    assert.deepEqual(branchEvidence.loads, [
      { repositoryId: IDENTITY.repository_id, runId: RUN_ID },
    ]);
  });

  it("fails a rerun when initial branch evidence is absent or conflicts", async () => {
    const rerunIdentity = { ...IDENTITY, run_attempt: 2 };
    for (const testCase of [
      {
        evidence: [] as readonly ApprovedBranchEvidence[],
        expectedCode: "approved-branch-evidence-missing",
      },
      {
        evidence: [
          validBranchEvidence({
            commitSha: "fedcba9876543210fedcba9876543210fedcba98",
          }),
        ],
        expectedCode: "approved-branch-evidence-conflict",
      },
    ]) {
      const { verifier } = verifierWith(
        {
          branchEvidence: testCase.evidence,
          run: validRunAttempt({ run_attempt: 2 }),
        },
        rerunIdentity,
      );
      assertRejected(
        await verifier.verify(rerunIdentity),
        "security-failure",
        testCase.expectedCode,
      );
    }
  });

  it("rejects a branch/tag collision and a moved main tip on the initial attempt", async () => {
    for (const gitRef of [
      validGitRef({ ref: "refs/tags/main" }),
      validGitRef({
        object: { type: "commit", sha: "fedcba9876543210fedcba9876543210fedcba98" },
      }),
      validGitRef({ object: { type: "tag", sha: HEAD_SHA } }),
    ]) {
      const { verifier, branchEvidence } = verifierWith({ gitRef });
      assertRejected(
        await verifier.verify(IDENTITY),
        "security-failure",
        "approved-branch-evidence-mismatch",
      );
      assert.equal(branchEvidence.records.length, 0);
    }

    const conflictingStore = verifierWith({
      branchEvidence: [
        validBranchEvidence({
          commitSha: "fedcba9876543210fedcba9876543210fedcba98",
        }),
      ],
    });
    assertRejected(
      await conflictingStore.verifier.verify(IDENTITY),
      "security-failure",
      "approved-branch-evidence-conflict",
    );
  });

  it("persists initial branch evidence only after every trust check passes", async () => {
    const { verifier, branchEvidence } = verifierWith({
      workflow: utf8(VALID_WORKFLOW.replace("timeout-minutes: 25", "timeout-minutes: 24")),
    });

    assertRejected(
      await verifier.verify(IDENTITY),
      "security-failure",
      "workload-timeout-not-approved-literal",
    );
    assert.equal(branchEvidence.records.length, 0);
  });

  it("selects the requested allocator check when one run has multiple approved mappings", async () => {
    const secondMapping: EnabledApprovedWorkloadMapping = {
      ...ENABLED_MAPPING,
      mappingPointer: "example-workload/another-job",
      allocator: {
        ...ENABLED_MAPPING.allocator,
        jobKey: "allocate-another-job",
        jobName: "Allocate another approved job",
        checkName: "Allocate another approved job / allocate",
      },
      workload: {
        ...ENABLED_MAPPING.workload,
        jobKey: "another-job",
        jobName: "Another job",
      },
    };
    const extraAllocator = {
      id: 91002,
      run_id: Number(RUN_ID),
      head_sha: HEAD_SHA,
      name: secondMapping.allocator.checkName,
      check_run_url: "https://api.github.com/repos/example-org/example-workload/check-runs/91002",
      status: "in_progress",
    };
    const client = new FakeWorkloadGitHubClient({
      getRepository: [validRepository()],
      getWorkflowRunAttempt: [validRunAttempt()],
      getGitRef: [validGitRef()],
      listJobsForWorkflowRunAttempt: [validJobs([extraAllocator])],
      getCheckRun: [validAllocatorCheck()],
      getCommit: [{ sha: HEAD_SHA }],
      getWorkflowBytes: [utf8(VALID_WORKFLOW)],
    });
    const verifier = new GitHubTrustVerifier({
      approvedMappings: [ENABLED_MAPPING, secondMapping],
      branchEvidence: new FakeApprovedBranchEvidenceStore(),
      clients: new FakeWorkloadGitHubClientProvider(client),
    });

    const result = await verifier.verify(IDENTITY);

    assert.equal(result.trusted, true);
    if (result.trusted) {
      assert.equal(result.evidence.mappingPointer, ENABLED_MAPPING.mappingPointer);
      assert.equal(result.evidence.allocator.checkRunId, CHECK_RUN_ID);
    }
  });

  it("treats a rerun as a new identity and checks triggering_actor again", async () => {
    const rerunIdentity = {
      ...IDENTITY,
      run_attempt: 2,
      allocator_check_run_id: "91002",
    };
    const rerunJob = {
      id: 91002,
      run_id: Number(RUN_ID),
      head_sha: HEAD_SHA,
      name: ENABLED_MAPPING.allocator.checkName,
      check_run_url: "https://api.github.com/repos/example-org/example-workload/check-runs/91002",
      status: "in_progress",
    };
    const { verifier } = verifierWith(
      {
        run: validRunAttempt({
          run_attempt: 2,
          triggering_actor: { id: 1 },
        }),
        jobs: { total_count: 1, jobs: [rerunJob] },
        check: validAllocatorCheck({ id: 91002 }),
      },
      rerunIdentity,
    );

    const result = await verifier.verify(rerunIdentity);

    assertRejected(result, "security-failure", "workflow-actor-not-approved");
  });

  it("requires both original actor.id and triggering_actor.id to equal the numeric owner ID", async () => {
    for (const run of [
      validRunAttempt({ actor: { id: 1 } }),
      validRunAttempt({ triggering_actor: { id: 1 } }),
      validRunAttempt({ actor: { id: Number(OWNER_GITHUB_USER_ID) }, triggering_actor: { id: 1 } }),
    ]) {
      const { verifier } = verifierWith({ run });
      assertRejected(
        await verifier.verify(IDENTITY),
        "security-failure",
        "workflow-actor-not-approved",
      );
    }
  });

  it("rejects repository, workflow, event, ref, attempt, commit and PR mismatches", async () => {
    const cases: ReadonlyArray<{
      readonly expectedCode: string;
      readonly identity?: typeof IDENTITY;
      readonly overrides: EvidenceOverrides;
    }> = [
      {
        expectedCode: "repository-identity-mismatch",
        overrides: { repository: { ...validRepository(), id: 1 } },
      },
      {
        expectedCode: "workflow-path-mismatch",
        overrides: { run: validRunAttempt({ path: ".github/workflows/other.yml@main" }) },
      },
      {
        expectedCode: "workflow-event-not-approved",
        overrides: { run: validRunAttempt({ event: "push" }) },
      },
      {
        expectedCode: "workflow-branch-name-mismatch",
        overrides: { run: validRunAttempt({ head_branch: "feature" }) },
      },
      {
        expectedCode: "run-attempt-mismatch",
        identity: { ...IDENTITY, run_attempt: 2 },
        overrides: {},
      },
      {
        expectedCode: "immutable-commit-mismatch",
        overrides: { commit: { sha: "fedcba9876543210fedcba9876543210fedcba98" } },
      },
      {
        expectedCode: "workflow-event-not-approved",
        overrides: { run: validRunAttempt({ pull_requests: [{ id: 1 }] }) },
      },
    ];

    for (const testCase of cases) {
      const identity = testCase.identity ?? IDENTITY;
      const { verifier } = verifierWith(testCase.overrides, identity);
      assertRejected(await verifier.verify(identity), "security-failure", testCase.expectedCode);
    }
  });

  it("rejects mismatched, replayed and ambiguous allocator check IDs", async () => {
    const replayIdentity = { ...IDENTITY, allocator_check_run_id: "91002" };
    const replay = verifierWith(
      { check: validAllocatorCheck({ id: 91002 }) },
      replayIdentity,
    ).verifier;
    assertRejected(
      await replay.verify(replayIdentity),
      "security-failure",
      "allocator-check-id-mismatch",
    );

    const duplicateName = {
      id: 91002,
      run_id: Number(RUN_ID),
      head_sha: HEAD_SHA,
      name: ENABLED_MAPPING.allocator.checkName,
      check_run_url: "https://api.github.com/repos/example-org/example-workload/check-runs/91002",
      status: "in_progress",
    };
    const ambiguous = verifierWith({ jobs: validJobs([duplicateName]) }).verifier;
    assertRejected(
      await ambiguous.verify(IDENTITY),
      "security-failure",
      "allocator-check-ambiguous",
    );

    const duplicateCheckUrl = {
      ...duplicateName,
      name: "Unrelated job",
      check_run_url: `https://api.github.com/repos/example-org/example-workload/check-runs/${CHECK_RUN_ID}`,
    };
    const replayedUrl = verifierWith({ jobs: validJobs([duplicateCheckUrl]) }).verifier;
    assertRejected(
      await replayedUrl.verify(IDENTITY),
      "security-failure",
      "allocator-check-id-ambiguous",
    );
  });

  it("parses the allocator Check Run ID only from a strict check_run_url", async () => {
    const validJob = (validJobs().jobs as Record<string, unknown>[])[0];
    assert.ok(validJob);
    for (const checkRunUrl of [
      `https://api.github.com/repos/example-org/example-workload/check-runs/${CHECK_RUN_ID}?x=1`,
      `https://api.github.com/repos/example-org/example-workload/check-runs/${CHECK_RUN_ID}/`,
      `https://api.github.com/repos/example-org/Other/check-runs/${CHECK_RUN_ID}`,
      `https://api.github.com/repos/example-org/example-workload/check-runs/%39%31%30%30%31`,
    ]) {
      const { verifier } = verifierWith({
        jobs: { total_count: 1, jobs: [{ ...validJob, check_run_url: checkRunUrl }] },
      });
      assertRejected(
        await verifier.verify(IDENTITY),
        "controller-unavailable",
        "allocator-check-url-invalid",
      );
    }
  });

  it("fails closed for missing fields and unknown GitHub transport shapes", async () => {
    const malformedValues: readonly EvidenceOverrides[] = [
      { repository: { full_name: "example-org/example-workload", private: true } },
      { run: { ...validRunAttempt(), actor: undefined } },
      { jobs: { total_count: 1, jobs: "not-an-array" } },
      { check: { ...validAllocatorCheck(), app: undefined } },
      { workflow: new Uint8Array([0xff, 0xfe]) },
    ];

    for (const overrides of malformedValues) {
      const { verifier } = verifierWith(overrides);
      const result = await verifier.verify(IDENTITY);
      assert.equal(result.trusted, false);
      if (!result.trusted) {
        assert.ok(
          result.failure.classification === "controller-unavailable" ||
            result.failure.classification === "security-failure",
        );
      }
    }
  });

  it("classifies unavailable GitHub evidence as a redacted controller failure", async () => {
    const client = new FakeWorkloadGitHubClient({
      getRepository: [
        new GitHubRequestError({
          classification: "github-api-failure",
          code: "github-api-status",
          requestId: "safe-request-id",
          retryable: true,
          status: 503,
        }),
      ],
      getWorkflowRunAttempt: [validRunAttempt()],
    });
    const verifier = new GitHubTrustVerifier({
      approvedMappings: [ENABLED_MAPPING],
      branchEvidence: new FakeApprovedBranchEvidenceStore(),
      clients: new FakeWorkloadGitHubClientProvider(client),
    });

    const result = await verifier.verify(IDENTITY);

    assertRejected(result, "controller-unavailable", "github-api-status");
    assert.equal(JSON.stringify(result).includes("safe-request-id"), false);
  });

  it("keeps the production Workload mapping disabled before GitHub or ledger access", async () => {
    const client = new FakeWorkloadGitHubClient();
    const provider = new FakeWorkloadGitHubClientProvider(client);
    const branchEvidence = new FakeApprovedBranchEvidenceStore();
    const verifier = new GitHubTrustVerifier({
      approvedMappings: [WORKLOAD_PRODUCTION_MAPPING],
      branchEvidence,
      clients: provider,
    });

    const result = await verifier.verify(IDENTITY);

    assertRejected(result, "invalid-configuration", "approved-mapping-disabled");
    assert.equal(provider.calls, 0);
    assert.deepEqual(client.requests, []);
    assert.deepEqual(branchEvidence.loads, []);
    assert.deepEqual(branchEvidence.records, []);
    assert.equal(WORKLOAD_PRODUCTION_MAPPING.workload.jobName, "Example approved build");
    assert.equal(
      WORKLOAD_PRODUCTION_MAPPING.reason,
      "Awaiting the exact allocator job and Actions Check Run names and approved reusable Switchyard workflow commit SHA",
    );
    assert.ok(!("allocator" in WORKLOAD_PRODUCTION_MAPPING));
  });
});

function verifierWith(
  overrides: EvidenceOverrides = {},
  _identity = IDENTITY,
): {
  readonly client: FakeWorkloadGitHubClient;
  readonly branchEvidence: FakeApprovedBranchEvidenceStore;
  readonly provider: WorkloadGitHubClientProvider;
  readonly verifier: GitHubTrustVerifier;
} {
  const client = new FakeWorkloadGitHubClient({
    getRepository: [overrides.repository ?? validRepository()],
    getWorkflowRunAttempt: [overrides.run ?? validRunAttempt()],
    getGitRef: [overrides.gitRef ?? validGitRef()],
    listJobsForWorkflowRunAttempt: [overrides.jobs ?? validJobs()],
    getCheckRun: [overrides.check ?? validAllocatorCheck()],
    getCommit: [overrides.commit ?? { sha: HEAD_SHA }],
    getWorkflowBytes: [overrides.workflow ?? utf8(VALID_WORKFLOW)],
  });
  const provider = new FakeWorkloadGitHubClientProvider(client);
  const branchEvidence = new FakeApprovedBranchEvidenceStore(overrides.branchEvidence);
  return {
    branchEvidence,
    client,
    provider,
    verifier: new GitHubTrustVerifier({
      approvedMappings: [ENABLED_MAPPING],
      branchEvidence,
      clients: provider,
    }),
  };
}

function assertRejected(
  result: Awaited<ReturnType<GitHubTrustVerifier["verify"]>>,
  classification: string,
  code: string,
): void {
  assert.equal(result.trusted, false);
  if (!result.trusted) {
    assert.equal(result.failure.classification, classification);
    assert.equal(result.failure.code, code);
  }
}
