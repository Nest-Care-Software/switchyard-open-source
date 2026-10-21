import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type AllocationRecord,
  type CheckRunCreationStore,
  initialiseCheckRunDelivery,
  type CheckRunDeliveryRecord,
  type SwitchyardCheckRunSnapshot,
} from "@switchyard/core";

import {
  DurableCheckRunCreationCoordinator,
  GitHubRequestError,
  SWITCHYARD_CHECK_RUN_NAME,
  SwitchyardCheckRunReporter,
  type WorkloadGitHubClientProvider,
} from "../src/index.js";
import {
  FakeCheckRunCreationCoordinator,
  FakeWorkloadGitHubClient,
  FakeWorkloadGitHubClientProvider,
} from "../src/testing/fakes.js";
import { HEAD_SHA } from "./fixtures.js";

const REPOSITORY = { owner: "example-org", name: "example-workload" } as const;
const ALLOCATION_ID = "allocation-123";

const ACCEPTED: SwitchyardCheckRunSnapshot = {
  allocationId: ALLOCATION_ID,
  headSha: HEAD_SHA,
  revision: 0,
  stage: "accepted",
  provider: null,
  durationSeconds: null,
  estimatedCostUsdCents: null,
  fallbackUsed: null,
  cleanupResult: null,
  workloadOutcome: null,
};

const PROVIDER_SELECTED: SwitchyardCheckRunSnapshot = {
  ...ACCEPTED,
  revision: 1,
  stage: "provider-selected",
  provider: "azure",
  fallbackUsed: false,
};

const ENDED: SwitchyardCheckRunSnapshot = {
  ...PROVIDER_SELECTED,
  revision: 3,
  stage: "ended",
  durationSeconds: 1520,
  estimatedCostUsdCents: 47,
  cleanupResult: "succeeded",
  workloadOutcome: "succeeded",
};

describe("Switchyard lifecycle Check Run reporter", () => {
  it("has no production fallback when an authoritative creation coordinator is absent", () => {
    assert.throws(
      () =>
        new SwitchyardCheckRunReporter({
          appSlug: "switchyard",
          clients: new FakeWorkloadGitHubClientProvider(new FakeWorkloadGitHubClient()),
          creationCoordinator: undefined as never,
          repository: REPOSITORY,
        }),
      /authoritative Check Run creation coordinator is required/,
    );
  });

  it("creates the lifecycle record on the immutable SHA and persists its numeric ID", async () => {
    const client = new FakeWorkloadGitHubClient({
      listCheckRunsForCommit: [{ total_count: 0, check_runs: [] }],
      createCheckRun: [publishedCheck("in_progress")],
    });
    const provider = new FakeWorkloadGitHubClientProvider(client);
    const coordinator = new FakeCheckRunCreationCoordinator();
    const reporter = createReporter(provider, { coordinator });

    const published = await reporter.publish(initialRecord(), ACCEPTED);

    assert.equal(published.lifecycle.phase, "in-progress");
    if (published.lifecycle.phase === "in-progress") {
      assert.equal(published.lifecycle.checkRunId, "5511");
      assert.equal(published.lifecycle.headSha, HEAD_SHA);
    }
    const createRequest = client.requests.find(({ operation }) => operation === "createCheckRun");
    const body = createRequest?.arguments[1] as Record<string, unknown>;
    assert.equal(body.name, SWITCHYARD_CHECK_RUN_NAME);
    assert.equal(body.head_sha, HEAD_SHA);
    assert.equal(body.external_id, ALLOCATION_ID);
    assert.equal(body.status, "in_progress");
    assert.equal(provider.calls, 1);
    assert.equal(coordinator.calls.length, 1);
  });

  it("recovers an ambiguous create through external_id lookup and then no-ops exact retries", async () => {
    const apiFailure = new GitHubRequestError({
      classification: "github-api-failure",
      code: "github-network-failure",
      requestId: null,
      retryable: true,
      status: null,
    });
    const client = new FakeWorkloadGitHubClient({
      listCheckRunsForCommit: [
        { total_count: 0, check_runs: [] },
        { total_count: 1, check_runs: [publishedCheck("in_progress")] },
      ],
      createCheckRun: [apiFailure],
    });
    const provider = new FakeWorkloadGitHubClientProvider(client);
    let now = new Date("2026-08-25T12:00:00Z");
    const reporter = createReporter(provider, { now: () => now });

    const failed = await reporter.publish(initialRecord(), ACCEPTED);
    assert.equal(failed.lifecycle.phase, "not-created");
    assert.equal(failed.retry?.operation, "create");
    assert.equal(failed.retry?.attempt, 1);

    now = new Date("2026-08-25T12:01:00Z");
    const recovered = await reporter.publish(failed, ACCEPTED);
    assert.equal(recovered.lifecycle.phase, "in-progress");
    assert.equal(recovered.retry, null);
    const noOp = await reporter.publish(recovered, ACCEPTED);
    assert.deepEqual(noOp, recovered);
    assert.equal(provider.calls, 2);
    assert.equal(
      client.requests.filter(({ operation }) => operation === "createCheckRun").length,
      1,
    );
  });

  it("updates through reconciliation and concludes only the ended allocation", async () => {
    const client = new FakeWorkloadGitHubClient({
      listCheckRunsForCommit: [{ total_count: 0, check_runs: [] }],
      createCheckRun: [publishedCheck("in_progress")],
      updateCheckRun: [publishedCheck("in_progress"), publishedCheck("completed", "success")],
    });
    const provider = new FakeWorkloadGitHubClientProvider(client);
    const reporter = createReporter(provider);

    const created = await reporter.publish(initialRecord(), ACCEPTED);
    const updated = await reporter.publish(created, PROVIDER_SELECTED);
    const concluded = await reporter.publish(updated, ENDED);

    assert.equal(concluded.lifecycle.phase, "concluded");
    const updateRequests = client.requests.filter(
      ({ operation }) => operation === "updateCheckRun",
    );
    const progressBody = updateRequests[0]?.arguments[2] as Record<string, unknown>;
    const conclusionBody = updateRequests[1]?.arguments[2] as Record<string, unknown>;
    assert.equal(progressBody.status, "in_progress");
    assert.equal(conclusionBody.status, "completed");
    assert.equal(conclusionBody.conclusion, "success");
    const output = conclusionBody.output as Record<string, string>;
    assert.match(output.summary ?? "", /Provider: azure/);
    assert.match(output.summary ?? "", /Duration: 1520 seconds/);
    assert.match(output.summary ?? "", /Estimated cost: \$0\.47/);
    assert.match(output.summary ?? "", /Fallback used: no/);
    assert.match(output.summary ?? "", /Cleanup: succeeded/);
    assert.equal((output.summary ?? "").toLowerCase().includes("post-job summary"), false);
  });

  it("returns update API failures as retry and alert data without changing safety state", async () => {
    const failure = new GitHubRequestError({
      classification: "github-api-failure",
      code: "github-api-status",
      requestId: "safe-id",
      retryable: true,
      status: 503,
    });
    const client = new FakeWorkloadGitHubClient({
      listCheckRunsForCommit: [{ total_count: 0, check_runs: [] }],
      createCheckRun: [publishedCheck("in_progress")],
      updateCheckRun: [failure, failure, failure],
    });
    let now = new Date("2026-08-25T12:00:00Z");
    const reporter = createReporter(new FakeWorkloadGitHubClientProvider(client), {
      now: () => now,
    });
    const created = await reporter.publish(initialRecord(), ACCEPTED);

    const first = await reporter.publish(created, PROVIDER_SELECTED);
    now = new Date("2026-08-25T12:01:00Z");
    const second = await reporter.publish(first, PROVIDER_SELECTED);
    now = new Date("2026-08-25T12:06:00Z");
    const third = await reporter.publish(second, PROVIDER_SELECTED);

    assert.deepEqual(third.lifecycle, created.lifecycle);
    assert.equal(third.retry?.attempt, 3);
    assert.equal(third.retry?.alertRequired, true);
    assert.deepEqual(third.retry?.failure, {
      classification: "github-api-failure",
      code: "github-api-status",
      requestId: "safe-id",
      retryable: true,
      status: 503,
    });
  });

  it("fails closed when idempotency lookup finds duplicate lifecycle records", async () => {
    const client = new FakeWorkloadGitHubClient({
      listCheckRunsForCommit: [
        {
          total_count: 2,
          check_runs: [publishedCheck("in_progress"), publishedCheck("in_progress", null, 5512)],
        },
      ],
    });
    const reporter = createReporter(new FakeWorkloadGitHubClientProvider(client));

    const result = await reporter.publish(initialRecord(), ACCEPTED);

    assert.equal(result.lifecycle.phase, "not-created");
    assert.equal(result.retry?.failure.classification, "github-response-invalid");
    assert.equal(result.retry?.alertRequired, true);
  });

  it("does not mint a token or call GitHub before retry notBefore", async () => {
    const failure = new GitHubRequestError({
      classification: "github-api-failure",
      code: "github-api-status",
      requestId: null,
      retryable: true,
      status: 503,
    });
    const client = new FakeWorkloadGitHubClient({
      listCheckRunsForCommit: [{ total_count: 0, check_runs: [] }],
      createCheckRun: [publishedCheck("in_progress")],
      updateCheckRun: [failure],
    });
    const provider = new FakeWorkloadGitHubClientProvider(client);
    let now = new Date("2026-08-25T12:00:00Z");
    const reporter = createReporter(provider, { now: () => now });
    const created = await reporter.publish(initialRecord(), ACCEPTED);
    const failed = await reporter.publish(created, PROVIDER_SELECTED);
    const callsAfterFailure = provider.calls;
    const requestsAfterFailure = client.requests.length;

    now = new Date("2026-08-25T12:00:59.999Z");
    const early = await reporter.publish(failed, PROVIDER_SELECTED);

    assert.deepEqual(early, failed);
    assert.equal(provider.calls, callsAfterFailure);
    assert.equal(client.requests.length, requestsAfterFailure);
  });

  it("coordinates concurrent Check Run creation so both callers adopt one ID", async () => {
    const client = new FakeWorkloadGitHubClient({
      listCheckRunsForCommit: [{ total_count: 0, check_runs: [] }],
      createCheckRun: [publishedCheck("in_progress")],
    });
    const provider = new FakeWorkloadGitHubClientProvider(client);
    const coordinator = new FakeCheckRunCreationCoordinator();
    const reporter = createReporter(provider, { coordinator });

    const [first, second] = await Promise.all([
      reporter.publish(initialRecord(), ACCEPTED),
      reporter.publish(initialRecord(), ACCEPTED),
    ]);

    assert.deepEqual(first, second);
    assert.equal(first.lifecycle.phase, "in-progress");
    assert.equal(provider.calls, 1);
    assert.equal(
      client.requests.filter(({ operation }) => operation === "listCheckRunsForCommit").length,
      1,
    );
    assert.equal(
      client.requests.filter(({ operation }) => operation === "createCheckRun").length,
      1,
    );
    assert.equal(coordinator.calls.length, 2);
  });
});

describe("durable Check Run creation coordinator", () => {
  it("persists the numeric result behind the acquired lease revision", async () => {
    const store = new FakeDurableCreationStore();
    const coordinator = new DurableCheckRunCreationCoordinator({
      createLeaseToken: () => "controller-1:call-1",
      leaseOwner: "controller-1",
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      store,
    });
    let calls = 0;
    const id = await coordinator.coordinate(
      {
        allocationId: ALLOCATION_ID,
        appSlug: "switchyard",
        headSha: HEAD_SHA,
        repository: REPOSITORY,
      },
      async () => {
        calls += 1;
        return "5511";
      },
    );

    assert.deepEqual(id, { checkRunId: "5511", outcome: "completed" });
    assert.equal(calls, 1);
    assert.equal(store.renewals.length, 1);
    assert.equal(store.completions[0]?.leaseRevision, 8);
    assert.equal(store.completions[0]?.checkRunId, "5511");
  });

  it("records a redacted failed delivery before propagating creation failure", async () => {
    const store = new FakeDurableCreationStore();
    const coordinator = new DurableCheckRunCreationCoordinator({
      createLeaseToken: () => "controller-1:call-1",
      leaseOwner: "controller-1",
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      store,
    });
    await assert.rejects(
      () =>
        coordinator.coordinate(
          {
            allocationId: ALLOCATION_ID,
            appSlug: "switchyard",
            headSha: HEAD_SHA,
            repository: REPOSITORY,
          },
          async () => {
            throw GitHubRequestError.invalidResponse("check-run-test-failure");
          },
        ),
      /check-run-test-failure/,
    );
    assert.equal(store.renewals.length, 1);
    assert.equal(store.failures[0]?.leaseRevision, 8);
    assert.equal(store.failures[0]?.failure.code, "check-run-test-failure");
  });

  it("waits for a concurrent lease holder then adopts its one persisted ID", async () => {
    const store = new FakeDurableCreationStore(true);
    let waits = 0;
    const coordinator = new DurableCheckRunCreationCoordinator({
      createLeaseToken: () => "controller-2:call-1",
      leaseOwner: "controller-2",
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      store,
      wait: async () => {
        waits += 1;
      },
    });
    const id = await coordinator.coordinate(
      {
        allocationId: ALLOCATION_ID,
        appSlug: "switchyard",
        headSha: HEAD_SHA,
        repository: REPOSITORY,
      },
      async () => {
        throw new Error("a concurrent adopter must not create another Check Run");
      },
    );
    assert.deepEqual(id, { checkRunId: "5511", outcome: "completed" });
    assert.equal(waits, 1);
  });

  it("returns a typed deferred result at the configurable two-second contention deadline", async () => {
    let monotonic = 0;
    let waits = 0;
    let waitedMilliseconds = 0;
    const store = {
      acquireCheckRunCreationLease: async () =>
        ({
          leaseExpiresAt: "2026-08-25T12:01:00.000Z",
          outcome: "busy",
        }) as const,
      completeCheckRunCreation: async () => {
        throw new Error("must not complete");
      },
      failCheckRunCreation: async () => {
        throw new Error("must not fail a lease that was not acquired");
      },
      renewCheckRunCreationLease: async () => {
        throw new Error("must not renew a lease that was not acquired");
      },
    };
    const coordinator = new DurableCheckRunCreationCoordinator({
      coordinationDeadlineMilliseconds: 2_000,
      createLeaseToken: () => "controller-2:bounded-contention",
      leaseOwner: "controller-2",
      monotonicNowMilliseconds: () => monotonic,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      store,
      wait: async (milliseconds) => {
        waits += 1;
        waitedMilliseconds += milliseconds;
        monotonic += milliseconds;
      },
    });
    let externalCalls = 0;
    assert.deepEqual(
      await coordinator.coordinate(creationKey(), async () => {
        externalCalls += 1;
        return "5511";
      }),
      { outcome: "deferred", reason: "lease-busy" },
    );
    assert.equal(waits, 8);
    assert.equal(waitedMilliseconds, 2_000);
    assert.equal(externalCalls, 0);
  });

  it("uses one lease token per invocation so one coordinator performs one external creation", async () => {
    const store = new StatefulCreationStore();
    const tokens = ["controller-1:call-1", "controller-1:call-2"];
    let externalCalls = 0;
    let externalStarted: (() => void) | undefined;
    let releaseExternal: ((value: string) => void) | undefined;
    let waitStarted: (() => void) | undefined;
    let releaseWait: (() => void) | undefined;
    const externalWasStarted = new Promise<void>((resolve) => {
      externalStarted = resolve;
    });
    const externalResult = new Promise<string>((resolve) => {
      releaseExternal = resolve;
    });
    const pollingStarted = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    const pollingMayContinue = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const coordinator = new DurableCheckRunCreationCoordinator({
      createLeaseToken: () => {
        const token = tokens.shift();
        if (token === undefined) throw new Error("unexpected coordinate invocation");
        return token;
      },
      leaseOwner: "controller-1",
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      store,
      wait: async () => {
        waitStarted?.();
        await pollingMayContinue;
      },
    });
    const first = coordinator.coordinate(creationKey(), async () => {
      externalCalls += 1;
      externalStarted?.();
      return externalResult;
    });
    await externalWasStarted;
    const second = coordinator.coordinate(creationKey(), async () => {
      externalCalls += 1;
      throw new Error("a concurrent invocation must not list or create another Check Run");
    });
    await pollingStarted;
    assert.equal(externalCalls, 1);
    assert.deepEqual(store.acquisitionOwners.slice(0, 2), [
      "controller-1:call-1",
      "controller-1:call-2",
    ]);

    releaseExternal?.("5511");
    assert.deepEqual(await first, { checkRunId: "5511", outcome: "completed" });
    releaseWait?.();
    assert.deepEqual(await second, { checkRunId: "5511", outcome: "completed" });
    assert.equal(externalCalls, 1);
    assert.equal(store.completionCount, 1);
  });

  it("rejects a lease-token collision while the first invocation is live", async () => {
    const store = new StatefulCreationStore();
    let now = new Date("2026-08-25T12:00:00.000Z");
    let releaseExternal: ((value: string) => void) | undefined;
    let externalStarted: (() => void) | undefined;
    const externalWasStarted = new Promise<void>((resolve) => {
      externalStarted = resolve;
    });
    const externalResult = new Promise<string>((resolve) => {
      releaseExternal = resolve;
    });
    const coordinator = new DurableCheckRunCreationCoordinator({
      createLeaseToken: () => "controller-1:colliding-call",
      leaseDurationSeconds: 1,
      leaseOwner: "controller-1",
      now: () => now,
      operationTimeoutMilliseconds: 900,
      store,
    });
    let externalCalls = 0;
    const first = coordinator.coordinate(creationKey(), async () => {
      externalCalls += 1;
      externalStarted?.();
      return externalResult;
    });
    await externalWasStarted;
    now = new Date("2026-08-25T12:00:01.001Z");

    await assert.rejects(
      () =>
        coordinator.coordinate(creationKey(), async () => {
          externalCalls += 1;
          return "6622";
        }),
      /check-run-coordinator-lease-token-reused/,
    );
    assert.equal(externalCalls, 1);

    releaseExternal?.("5511");
    await assert.rejects(first, /check-run-creation-lease-fenced/);
    assert.equal(store.completionCount, 0);
  });

  it("fences a stale creator after lease takeover before durable persistence", async () => {
    const store = new StatefulCreationStore();
    let now = new Date("2026-08-25T12:00:00.000Z");
    const first = new DurableCheckRunCreationCoordinator({
      createLeaseToken: () => "controller-1:call-1",
      leaseDurationSeconds: 2,
      leaseOwner: "controller-1",
      now: () => now,
      operationTimeoutMilliseconds: 1_500,
      store,
    });
    const second = new DurableCheckRunCreationCoordinator({
      createLeaseToken: () => "controller-2:call-1",
      leaseDurationSeconds: 2,
      leaseOwner: "controller-2",
      now: () => now,
      operationTimeoutMilliseconds: 1_500,
      store,
    });
    let resolveFirst: ((value: string) => void) | undefined;
    const firstPublication = first.coordinate(
      creationKey(),
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    await Promise.resolve();
    assert.equal(store.leaseOwner, "controller-1:call-1");

    now = new Date("2026-08-25T12:00:02.001Z");
    const adopted = await second.coordinate(creationKey(), async () => "5511");
    assert.deepEqual(adopted, { checkRunId: "5511", outcome: "completed" });
    assert.equal(store.completedBy, "controller-2:call-1");

    assert.ok(resolveFirst);
    resolveFirst("5511");
    await assert.rejects(firstPublication, /check-run-creation-lease-fenced/);
    assert.equal(store.completionCount, 1);
  });

  it("bounds an unresolved external operation and retains its lease for recovery", async () => {
    const store = new StatefulCreationStore();
    const coordinator = new DurableCheckRunCreationCoordinator({
      createLeaseToken: () => "controller-1:call-1",
      leaseDurationSeconds: 1,
      leaseOwner: "controller-1",
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      operationTimeoutMilliseconds: 5,
      store,
    });
    await assert.rejects(
      () => coordinator.coordinate(creationKey(), () => new Promise<string>(() => undefined)),
      /check-run-creation-operation-timeout/,
    );
    assert.equal(store.leaseOwner, "controller-1:call-1");
    assert.equal(store.failureCount, 0);
    assert.equal(store.completionCount, 0);
  });

  it("bounds protected tokens and reclaims only expired recoverable leases", async () => {
    const store = new FakeDurableCreationStore();
    let now = new Date("2026-08-25T12:00:00.000Z");
    const tokens = ["controller-1:call-1", "controller-1:call-2", "controller-1:call-1"];
    const coordinator = new DurableCheckRunCreationCoordinator({
      createLeaseToken: () => {
        const token = tokens.shift();
        if (token === undefined) throw new Error("unexpected coordinate invocation");
        return token;
      },
      leaseDurationSeconds: 1,
      leaseOwner: "controller-1",
      maxProtectedLeaseTokens: 2,
      now: () => now,
      operationTimeoutMilliseconds: 5,
      store,
    });
    let externalCalls = 0;
    const neverResolves = () => {
      externalCalls += 1;
      return new Promise<string>(() => undefined);
    };

    await assert.rejects(
      () => coordinator.coordinate(creationKey(), neverResolves),
      /check-run-creation-operation-timeout/,
    );
    await assert.rejects(
      () => coordinator.coordinate(creationKey(), neverResolves),
      /check-run-creation-operation-timeout/,
    );
    await assert.rejects(
      () => coordinator.coordinate(creationKey(), async () => "6622"),
      /check-run-coordinator-lease-token-capacity-exhausted/,
    );
    assert.equal(externalCalls, 2);

    now = new Date("2026-08-25T12:00:01.001Z");
    assert.deepEqual(await coordinator.coordinate(creationKey(), async () => "5511"), {
      checkRunId: "5511",
      outcome: "completed",
    });
    assert.equal(tokens.length, 0);
  });
});

function creationKey() {
  return {
    allocationId: ALLOCATION_ID,
    appSlug: "switchyard",
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  } as const;
}

function initialRecord(): CheckRunDeliveryRecord {
  return initialiseCheckRunDelivery({ allocationId: ALLOCATION_ID, headSha: HEAD_SHA });
}

function createReporter(
  clients: WorkloadGitHubClientProvider,
  options: {
    readonly coordinator?: FakeCheckRunCreationCoordinator;
    readonly now?: () => Date;
  } = {},
) {
  return new SwitchyardCheckRunReporter({
    appSlug: "switchyard",
    clients,
    creationCoordinator: options.coordinator ?? new FakeCheckRunCreationCoordinator(),
    repository: REPOSITORY,
    now: options.now ?? (() => new Date("2026-08-25T12:00:00Z")),
  });
}

function publishedCheck(
  status: "completed" | "in_progress",
  conclusion: "success" | null = null,
  id = 5511,
): Record<string, unknown> {
  return {
    id,
    head_sha: HEAD_SHA,
    name: SWITCHYARD_CHECK_RUN_NAME,
    external_id: ALLOCATION_ID,
    app: { slug: "switchyard" },
    status,
    conclusion,
  };
}

class FakeDurableCreationStore implements CheckRunCreationStore {
  readonly completions: Array<Parameters<CheckRunCreationStore["completeCheckRunCreation"]>[0]> =
    [];
  readonly failures: Array<Parameters<CheckRunCreationStore["failCheckRunCreation"]>[0]> = [];
  readonly renewals: Array<Parameters<CheckRunCreationStore["renewCheckRunCreationLease"]>[0]> = [];
  readonly #adoptAfterBusy: boolean;
  #acquisitionCalls = 0;

  constructor(adoptAfterBusy = false) {
    this.#adoptAfterBusy = adoptAfterBusy;
  }

  async acquireCheckRunCreationLease(
    request: Parameters<CheckRunCreationStore["acquireCheckRunCreationLease"]>[0],
  ) {
    await Promise.resolve();
    this.#acquisitionCalls += 1;
    if (this.#adoptAfterBusy && this.#acquisitionCalls === 1) {
      return {
        leaseExpiresAt: "2026-08-25T12:01:00.000Z",
        outcome: "busy",
      } as const;
    }
    if (this.#adoptAfterBusy) {
      return { checkRunId: "5511", outcome: "completed" } as const;
    }
    return {
      leaseExpiresAt: request.leaseExpiresAt,
      leaseOwner: request.leaseOwner,
      leaseRevision: 7,
      outcome: "acquired",
    } as const;
  }

  async completeCheckRunCreation(
    request: Parameters<CheckRunCreationStore["completeCheckRunCreation"]>[0],
  ): Promise<AllocationRecord> {
    this.completions.push(request);
    return {
      checkRunCreation: {
        delivery: {
          lifecycle: {
            allocationId: ALLOCATION_ID,
            checkRunId: request.checkRunId,
            headSha: HEAD_SHA,
            phase: "in-progress",
            publishedRevision: 0,
            stage: "accepted",
          },
          retry: null,
        },
      },
    } as AllocationRecord;
  }

  async renewCheckRunCreationLease(
    request: Parameters<CheckRunCreationStore["renewCheckRunCreationLease"]>[0],
  ) {
    this.renewals.push(request);
    return {
      leaseExpiresAt: request.leaseExpiresAt,
      leaseOwner: request.leaseOwner,
      leaseRevision: request.leaseRevision + 1,
    };
  }

  async failCheckRunCreation(
    request: Parameters<CheckRunCreationStore["failCheckRunCreation"]>[0],
  ): Promise<AllocationRecord> {
    this.failures.push(request);
    return { checkRunCreation: { delivery: initialRecord() } } as AllocationRecord;
  }
}

class StatefulCreationStore implements CheckRunCreationStore {
  readonly acquisitionOwners: string[] = [];
  completedBy: string | null = null;
  completionCount = 0;
  failureCount = 0;
  leaseOwner: string | null = null;
  #checkRunId: string | null = null;
  #leaseExpiresAt: string | null = null;
  #leaseRevision = 0;

  async acquireCheckRunCreationLease(
    request: Parameters<CheckRunCreationStore["acquireCheckRunCreationLease"]>[0],
  ) {
    this.acquisitionOwners.push(request.leaseOwner);
    if (this.#checkRunId !== null) {
      return { checkRunId: this.#checkRunId, outcome: "completed" } as const;
    }
    if (
      this.leaseOwner !== null &&
      this.#leaseExpiresAt !== null &&
      request.acquiredAt <= this.#leaseExpiresAt
    ) {
      return { leaseExpiresAt: this.#leaseExpiresAt, outcome: "busy" } as const;
    }
    this.leaseOwner = request.leaseOwner;
    this.#leaseExpiresAt = request.leaseExpiresAt;
    this.#leaseRevision += 1;
    return {
      leaseExpiresAt: request.leaseExpiresAt,
      leaseOwner: request.leaseOwner,
      leaseRevision: this.#leaseRevision,
      outcome: "acquired",
    } as const;
  }

  async renewCheckRunCreationLease(
    request: Parameters<CheckRunCreationStore["renewCheckRunCreationLease"]>[0],
  ) {
    this.#assertHolder(request.leaseOwner, request.leaseRevision, request.renewedAt);
    this.#leaseRevision += 1;
    this.#leaseExpiresAt = request.leaseExpiresAt;
    return {
      leaseExpiresAt: request.leaseExpiresAt,
      leaseOwner: request.leaseOwner,
      leaseRevision: this.#leaseRevision,
    };
  }

  async completeCheckRunCreation(
    request: Parameters<CheckRunCreationStore["completeCheckRunCreation"]>[0],
  ): Promise<AllocationRecord> {
    this.#assertHolder(request.leaseOwner, request.leaseRevision, request.completedAt);
    this.#checkRunId = request.checkRunId;
    this.completedBy = request.leaseOwner;
    this.completionCount += 1;
    this.leaseOwner = null;
    this.#leaseExpiresAt = null;
    return {
      checkRunCreation: {
        delivery: {
          lifecycle: {
            allocationId: ALLOCATION_ID,
            checkRunId: request.checkRunId,
            headSha: HEAD_SHA,
            phase: "in-progress",
            publishedRevision: 0,
            stage: "accepted",
          },
          retry: null,
        },
      },
    } as AllocationRecord;
  }

  async failCheckRunCreation(
    request: Parameters<CheckRunCreationStore["failCheckRunCreation"]>[0],
  ): Promise<AllocationRecord> {
    this.#assertHolder(request.leaseOwner, request.leaseRevision, request.failedAt);
    this.failureCount += 1;
    this.leaseOwner = null;
    this.#leaseExpiresAt = null;
    return { checkRunCreation: { delivery: initialRecord() } } as AllocationRecord;
  }

  #assertHolder(owner: string, revision: number, at: string): void {
    if (
      this.#checkRunId !== null ||
      this.leaseOwner !== owner ||
      this.#leaseRevision !== revision ||
      this.#leaseExpiresAt === null ||
      at > this.#leaseExpiresAt
    ) {
      throw GitHubRequestError.invalidResponse("check-run-creation-lease-fenced");
    }
  }
}
