import { randomUUID } from "node:crypto";

import {
  applyCheckRunDeliverySuccess,
  CHECK_RUN_CREATION_LEASE_MAX_SECONDS,
  type CheckRunCreationStore,
  MAX_CHECK_RUN_DELIVERY_ATTEMPTS,
  planCheckRunDelivery,
  requireFullCommitSha,
  requirePositiveDecimalString,
  scheduleCheckRunRetry,
  type CheckRunDeliveryCommand,
  type CheckRunDeliveryRecord,
  type SwitchyardCheckRunSnapshot,
} from "@switchyard/core";

import {
  GitHubRequestError,
  safeGitHubFailure,
  type GitHubRepositoryCoordinates,
  type WorkloadGitHubClient,
  type WorkloadGitHubClientProvider,
} from "./api.js";

export const SWITCHYARD_CHECK_RUN_NAME = "Switchyard" as const;

export interface CheckRunCreationKey {
  readonly allocationId: string;
  readonly appSlug: string;
  readonly headSha: string;
  readonly repository: GitHubRepositoryCoordinates;
}

interface AcquiredCheckRunCreationLease {
  readonly leaseExpiresAt: string;
  readonly leaseOwner: string;
  readonly leaseRevision: number;
  readonly outcome: "acquired";
}

interface ProtectedLeaseToken {
  active: boolean;
  protectUntil: number;
}

const DEFAULT_MAX_PROTECTED_LEASE_TOKENS = 4_096;
const MAX_CONFIGURED_PROTECTED_LEASE_TOKENS = 65_536;

/**
 * The controller must provide an authoritative implementation which leases and
 * durably records one Check Run ID. The lease serialises controller intent, but
 * GitHub lookup and creation are separate API operations and are not atomic.
 */
export interface CheckRunCreationCoordinator {
  coordinate(
    key: CheckRunCreationKey,
    listOrCreate: () => Promise<string>,
  ): Promise<CheckRunCreationCoordinationResult>;
}

export type CheckRunCreationCoordinationResult =
  | { readonly checkRunId: string; readonly outcome: "completed" }
  | {
      readonly notBefore?: string;
      readonly outcome: "deferred";
      readonly reason: "lease-busy" | "retry-not-before";
    };

/** Durable lease fencing for the one lifecycle Check Run created per allocation. */
export class DurableCheckRunCreationCoordinator implements CheckRunCreationCoordinator {
  readonly #createLeaseToken: () => string;
  readonly #coordinationDeadlineMilliseconds: number;
  readonly #leaseDurationSeconds: number;
  readonly #maxProtectedLeaseTokens: number;
  readonly #monotonicNowMilliseconds: () => number;
  readonly #now: () => Date;
  readonly #operationTimeoutMilliseconds: number;
  readonly #store: CheckRunCreationStore;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #protectedLeaseTokens = new Map<string, ProtectedLeaseToken>();

  constructor(options: {
    readonly coordinationDeadlineMilliseconds?: number;
    readonly createLeaseToken?: () => string;
    readonly leaseDurationSeconds?: number;
    readonly leaseOwner: string;
    readonly maxProtectedLeaseTokens?: number;
    readonly monotonicNowMilliseconds?: () => number;
    readonly now?: () => Date;
    readonly operationTimeoutMilliseconds?: number;
    readonly store: CheckRunCreationStore;
    readonly wait?: (milliseconds: number) => Promise<void>;
  }) {
    const duration = options.leaseDurationSeconds ?? 60;
    const coordinationDeadlineMilliseconds = options.coordinationDeadlineMilliseconds ?? 2_000;
    const maxProtectedLeaseTokens =
      options.maxProtectedLeaseTokens ?? DEFAULT_MAX_PROTECTED_LEASE_TOKENS;
    const operationTimeoutMilliseconds = options.operationTimeoutMilliseconds ?? 30_000;
    if (
      !Number.isSafeInteger(duration) ||
      duration < 1 ||
      duration > CHECK_RUN_CREATION_LEASE_MAX_SECONDS
    ) {
      throw new TypeError(`leaseDurationSeconds must be 1-${CHECK_RUN_CREATION_LEASE_MAX_SECONDS}`);
    }
    if (
      typeof options.leaseOwner !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,89}$/.test(options.leaseOwner)
    ) {
      throw new TypeError("leaseOwner must be a bounded controller instance identifier");
    }
    if (typeof options.store?.acquireCheckRunCreationLease !== "function") {
      throw new TypeError("an authoritative Check Run creation store is required");
    }
    if (
      !Number.isSafeInteger(maxProtectedLeaseTokens) ||
      maxProtectedLeaseTokens < 1 ||
      maxProtectedLeaseTokens > MAX_CONFIGURED_PROTECTED_LEASE_TOKENS
    ) {
      throw new TypeError(
        `maxProtectedLeaseTokens must be 1-${MAX_CONFIGURED_PROTECTED_LEASE_TOKENS}`,
      );
    }
    if (
      !Number.isSafeInteger(coordinationDeadlineMilliseconds) ||
      coordinationDeadlineMilliseconds < 1 ||
      coordinationDeadlineMilliseconds > 30_000
    ) {
      throw new TypeError("coordinationDeadlineMilliseconds must be 1-30000");
    }
    if (
      !Number.isSafeInteger(operationTimeoutMilliseconds) ||
      operationTimeoutMilliseconds < 1 ||
      operationTimeoutMilliseconds >= duration * 1000
    ) {
      throw new TypeError("operationTimeoutMilliseconds must fit strictly within the lease");
    }
    this.#createLeaseToken =
      options.createLeaseToken ?? (() => `${options.leaseOwner}:${randomUUID()}`);
    this.#coordinationDeadlineMilliseconds = coordinationDeadlineMilliseconds;
    this.#leaseDurationSeconds = duration;
    this.#maxProtectedLeaseTokens = maxProtectedLeaseTokens;
    this.#monotonicNowMilliseconds = options.monotonicNowMilliseconds ?? (() => performance.now());
    this.#now = options.now ?? (() => new Date());
    this.#operationTimeoutMilliseconds = operationTimeoutMilliseconds;
    this.#store = options.store;
    this.#wait = options.wait ?? waitFor;
  }

  async coordinate(
    key: CheckRunCreationKey,
    listOrCreate: () => Promise<string>,
  ): Promise<CheckRunCreationCoordinationResult> {
    const issuedAt = this.#requiredNow();
    const leaseOwner = this.#requiredInvocationLeaseToken(issuedAt);
    let leaseReleased = false;
    try {
      const lease = await this.#acquireOrAdopt(key, leaseOwner);
      if (lease.outcome !== "acquired") {
        leaseReleased = true;
        if (lease.outcome === "completed") {
          return { checkRunId: lease.checkRunId, outcome: "completed" };
        }
        if (lease.outcome === "deferred") {
          if ("reason" in lease) {
            return lease;
          }
          return {
            notBefore: lease.notBefore,
            outcome: "deferred",
            reason: "retry-not-before",
          };
        }
        if (lease.outcome === "exhausted") {
          throw GitHubRequestError.invalidResponse("check-run-creation-retries-exhausted");
        }
      }
      this.#protectLeaseTokenUntil(leaseOwner, lease.leaseExpiresAt);
      let checkRunId: string;
      try {
        checkRunId = requirePositiveDecimalString(
          await this.#boundedExternalOperation(listOrCreate),
          "createdCheckRunId",
        );
      } catch (error) {
        if (isCreationOperationTimeout(error)) {
          // The external promise may still be resolving. Keep the lease held so a
          // later holder must recover through the immutable external_id lookup.
          throw error;
        }
        const renewed = await this.#renew(key.allocationId, lease, leaseOwner);
        await this.#store.failCheckRunCreation({
          allocationId: key.allocationId,
          failedAt: this.#requiredNow(),
          failure: safeGitHubFailure(error),
          leaseOwner: renewed.leaseOwner,
          leaseRevision: renewed.leaseRevision,
        });
        leaseReleased = true;
        throw error;
      }

      const renewed = await this.#renew(key.allocationId, lease, leaseOwner);
      const completed = await this.#store.completeCheckRunCreation({
        allocationId: key.allocationId,
        checkRunId,
        completedAt: this.#requiredNow(),
        leaseOwner: renewed.leaseOwner,
        leaseRevision: renewed.leaseRevision,
      });
      const lifecycle = completed.checkRunCreation.delivery.lifecycle;
      if (lifecycle.phase === "not-created" || lifecycle.checkRunId !== checkRunId) {
        throw GitHubRequestError.invalidResponse("check-run-creation-id-not-persisted");
      }
      leaseReleased = true;
      return { checkRunId, outcome: "completed" };
    } finally {
      this.#finishLeaseToken(leaseOwner, leaseReleased);
    }
  }

  async #renew(allocationId: string, lease: AcquiredCheckRunCreationLease, leaseOwner: string) {
    const renewedAt = this.#requiredNow();
    const proposedExpiry = new Date(
      Date.parse(renewedAt) + this.#leaseDurationSeconds * 1000,
    ).toISOString();
    const requestedExpiry =
      proposedExpiry < lease.leaseExpiresAt ? lease.leaseExpiresAt : proposedExpiry;
    // Protect the token before the durable request. A lost response may mean
    // the renewed lease exists even though this process never sees it.
    this.#protectLeaseTokenUntil(leaseOwner, requestedExpiry);
    const renewed = await this.#store.renewCheckRunCreationLease({
      allocationId,
      leaseExpiresAt: requestedExpiry,
      leaseOwner,
      leaseRevision: lease.leaseRevision,
      renewedAt,
    });
    this.#protectLeaseTokenUntil(leaseOwner, renewed.leaseExpiresAt);
    return renewed;
  }

  async #boundedExternalOperation(operation: () => Promise<string>): Promise<string> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(GitHubRequestError.invalidResponse("check-run-creation-operation-timeout")),
            this.#operationTimeoutMilliseconds,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async #acquireOrAdopt(key: CheckRunCreationKey, leaseOwner: string) {
    const startedAt = this.#requiredMonotonicNow();
    const deadline = startedAt + this.#coordinationDeadlineMilliseconds;
    while (true) {
      const acquiredAt = this.#requiredNow();
      const leaseExpiresAt = new Date(
        Date.parse(acquiredAt) + this.#leaseDurationSeconds * 1000,
      ).toISOString();
      // Protect the token before the durable request. A lost acquisition
      // response is recoverable until this requested lease has expired.
      this.#protectLeaseTokenUntil(leaseOwner, leaseExpiresAt);
      const lease = await this.#store.acquireCheckRunCreationLease({
        ...key,
        acquiredAt,
        leaseExpiresAt,
        leaseOwner,
      });
      if (lease.outcome !== "busy") return lease;
      const monotonicNow = this.#requiredMonotonicNow();
      if (monotonicNow >= deadline) {
        return { outcome: "deferred", reason: "lease-busy" } as const;
      }
      const remaining = Date.parse(lease.leaseExpiresAt) - Date.parse(acquiredAt) + 1;
      await this.#wait(Math.max(1, Math.min(250, remaining, Math.ceil(deadline - monotonicNow))));
    }
  }

  #requiredMonotonicNow(): number {
    const now = this.#monotonicNowMilliseconds();
    if (!Number.isFinite(now) || now < 0) {
      throw GitHubRequestError.invalidResponse("check-run-coordinator-clock-invalid");
    }
    return now;
  }

  #requiredNow(): string {
    const now = this.#now();
    if (!Number.isFinite(now.valueOf())) {
      throw GitHubRequestError.invalidResponse("check-run-coordinator-clock-invalid");
    }
    return now.toISOString();
  }

  #requiredInvocationLeaseToken(issuedAt: string): string {
    const issuedAtMilliseconds = Date.parse(issuedAt);
    this.#pruneExpiredLeaseTokens(issuedAtMilliseconds);
    if (this.#protectedLeaseTokens.size >= this.#maxProtectedLeaseTokens) {
      throw GitHubRequestError.invalidResponse(
        "check-run-coordinator-lease-token-capacity-exhausted",
      );
    }
    const token = this.#createLeaseToken();
    if (typeof token !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(token)) {
      throw GitHubRequestError.invalidResponse("check-run-coordinator-lease-token-invalid");
    }
    if (this.#protectedLeaseTokens.has(token)) {
      throw GitHubRequestError.invalidResponse("check-run-coordinator-lease-token-reused");
    }
    this.#protectedLeaseTokens.set(token, {
      active: true,
      protectUntil: issuedAtMilliseconds + this.#leaseDurationSeconds * 1000,
    });
    return token;
  }

  #protectLeaseTokenUntil(token: string, leaseExpiresAt: string): void {
    const protectedToken = this.#protectedLeaseTokens.get(token);
    if (protectedToken === undefined) return;
    const expiry = Date.parse(leaseExpiresAt);
    if (!Number.isFinite(expiry)) {
      throw GitHubRequestError.invalidResponse("check-run-coordinator-lease-expiry-invalid");
    }
    protectedToken.protectUntil = Math.max(protectedToken.protectUntil, expiry);
  }

  #finishLeaseToken(token: string, leaseReleased: boolean): void {
    if (leaseReleased) {
      this.#protectedLeaseTokens.delete(token);
      return;
    }
    const protectedToken = this.#protectedLeaseTokens.get(token);
    if (protectedToken !== undefined) protectedToken.active = false;
  }

  #pruneExpiredLeaseTokens(now: number): void {
    for (const [token, protectedToken] of this.#protectedLeaseTokens) {
      if (!protectedToken.active && now > protectedToken.protectUntil) {
        this.#protectedLeaseTokens.delete(token);
      }
    }
  }
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isCreationOperationTimeout(error: unknown): boolean {
  return (
    error instanceof GitHubRequestError &&
    error.failure.code === "check-run-creation-operation-timeout"
  );
}

export class SwitchyardCheckRunReporter {
  readonly #appSlug: string;
  readonly #clients: WorkloadGitHubClientProvider;
  readonly #creationCoordinator: CheckRunCreationCoordinator;
  readonly #now: () => Date;
  readonly #repository: GitHubRepositoryCoordinates;

  constructor(options: {
    readonly appSlug: string;
    readonly clients: WorkloadGitHubClientProvider;
    readonly creationCoordinator: CheckRunCreationCoordinator;
    readonly now?: () => Date;
    readonly repository: GitHubRepositoryCoordinates;
  }) {
    if (typeof options.creationCoordinator?.coordinate !== "function") {
      throw new TypeError("An authoritative Check Run creation coordinator is required");
    }
    this.#appSlug = options.appSlug;
    this.#clients = options.clients;
    this.#creationCoordinator = options.creationCoordinator;
    this.#now = options.now ?? (() => new Date());
    this.#repository = options.repository;
  }

  async publish(
    record: CheckRunDeliveryRecord,
    snapshotValue: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CheckRunDeliveryRecord> {
    const command = planCheckRunDelivery(record, snapshotValue);
    if (command.operation === "noop") {
      return record;
    }

    const now = this.#now();
    if (!Number.isFinite(now.valueOf())) {
      return scheduleCheckRunRetry(
        record,
        command.operation,
        GitHubRequestError.invalidResponse("check-run-clock-invalid").failure,
        new Date(0),
      );
    }
    if (record.retry !== null) {
      if (record.retry.attempt >= MAX_CHECK_RUN_DELIVERY_ATTEMPTS) {
        return record;
      }
      const notBefore = Date.parse(record.retry.notBefore);
      if (!Number.isFinite(notBefore)) {
        return scheduleCheckRunRetry(
          record,
          command.operation,
          GitHubRequestError.invalidResponse("check-run-retry-time-invalid").failure,
          now,
        );
      }
      if (now.valueOf() < notBefore) {
        return record;
      }
    }

    try {
      const persistedCheckRunId =
        record.lifecycle.phase === "not-created" ? null : record.lifecycle.checkRunId;
      let checkRunId: string;
      if (command.operation === "create") {
        const coordination = await this.#creationCoordinator.coordinate(
          {
            allocationId: command.snapshot.allocationId,
            appSlug: this.#appSlug,
            headSha: command.snapshot.headSha,
            repository: this.#repository,
          },
          () =>
            this.#clients.withWorkloadClient(
              (client) => this.#publishCommand(client, command, persistedCheckRunId, now),
              options,
            ),
        );
        if (coordination.outcome === "deferred") {
          throw GitHubRequestError.invalidResponse("check-run-creation-coordination-deferred");
        }
        checkRunId = coordination.checkRunId;
      } else {
        checkRunId = await this.#clients.withWorkloadClient(
          (client) => this.#publishCommand(client, command, persistedCheckRunId, now),
          options,
        );
      }
      return applyCheckRunDeliverySuccess(record, command, checkRunId);
    } catch (error) {
      return scheduleCheckRunRetry(record, command.operation, safeGitHubFailure(error), now);
    }
  }

  async #publishCommand(
    client: WorkloadGitHubClient,
    command: Exclude<CheckRunDeliveryCommand, { readonly operation: "noop" }>,
    persistedCheckRunId: string | null,
    now: Date,
  ): Promise<string> {
    if (command.operation === "create") {
      const existing = await findExistingCheckRun(
        client,
        this.#repository,
        command.snapshot,
        this.#appSlug,
      );
      if (existing !== null) {
        return existing;
      }
      const response = await client.createCheckRun(
        this.#repository,
        createCheckRunBody(command.snapshot, now),
      );
      return verifyPublishedCheckRun(response, command.snapshot, this.#appSlug, "in_progress");
    }

    if (persistedCheckRunId === null) {
      throw GitHubRequestError.invalidResponse("check-run-state-id-missing");
    }
    const response = await client.updateCheckRun(
      this.#repository,
      persistedCheckRunId,
      updateCheckRunBody(command.snapshot, now),
    );
    const expectedStatus = command.operation === "conclude" ? "completed" : "in_progress";
    const publishedId = verifyPublishedCheckRun(
      response,
      command.snapshot,
      this.#appSlug,
      expectedStatus,
    );
    if (publishedId !== persistedCheckRunId) {
      throw GitHubRequestError.invalidResponse("check-run-id-mismatch");
    }
    return publishedId;
  }
}

async function findExistingCheckRun(
  client: WorkloadGitHubClient,
  repository: GitHubRepositoryCoordinates,
  snapshot: SwitchyardCheckRunSnapshot,
  appSlug: string,
): Promise<string | null> {
  const value = await client.listCheckRunsForCommit(
    repository,
    snapshot.headSha,
    SWITCHYARD_CHECK_RUN_NAME,
  );
  const envelope = remoteRecord(value);
  if (!Array.isArray(envelope.check_runs)) {
    throw GitHubRequestError.invalidResponse("check-run-list-shape-invalid");
  }
  if (
    !Number.isSafeInteger(envelope.total_count) ||
    envelope.total_count !== envelope.check_runs.length ||
    envelope.check_runs.length > 100
  ) {
    throw GitHubRequestError.invalidResponse("check-run-list-ambiguous");
  }

  const candidates = envelope.check_runs.filter((entry) => {
    const check = remoteRecord(entry);
    const app = remoteRecord(check.app);
    return (
      check.name === SWITCHYARD_CHECK_RUN_NAME &&
      check.external_id === snapshot.allocationId &&
      check.head_sha === snapshot.headSha &&
      app.slug === appSlug
    );
  });
  if (candidates.length > 1) {
    throw GitHubRequestError.invalidResponse("check-run-idempotency-ambiguous");
  }
  const existing = candidates[0];
  if (existing === undefined) {
    return null;
  }
  if (existing.status !== "in_progress") {
    throw GitHubRequestError.invalidResponse("check-run-existing-state-invalid");
  }
  return remoteGitHubId(existing.id);
}

function createCheckRunBody(
  snapshot: SwitchyardCheckRunSnapshot,
  now: Date,
): Readonly<Record<string, unknown>> {
  return {
    name: SWITCHYARD_CHECK_RUN_NAME,
    head_sha: snapshot.headSha,
    status: "in_progress",
    external_id: snapshot.allocationId,
    started_at: now.toISOString(),
    output: renderOutput(snapshot),
  };
}

function updateCheckRunBody(
  snapshot: SwitchyardCheckRunSnapshot,
  now: Date,
): Readonly<Record<string, unknown>> {
  if (snapshot.stage === "ended") {
    return {
      name: SWITCHYARD_CHECK_RUN_NAME,
      status: "completed",
      conclusion: conclusionFor(snapshot),
      completed_at: now.toISOString(),
      external_id: snapshot.allocationId,
      output: renderOutput(snapshot),
    };
  }

  return {
    name: SWITCHYARD_CHECK_RUN_NAME,
    status: "in_progress",
    external_id: snapshot.allocationId,
    output: renderOutput(snapshot),
  };
}

function renderOutput(snapshot: SwitchyardCheckRunSnapshot): {
  readonly summary: string;
  readonly title: string;
} {
  if (snapshot.stage === "accepted") {
    return {
      title: "Allocation accepted",
      summary: "Switchyard accepted the allocation. Provider selection is pending.",
    };
  }

  const provider = snapshot.provider ?? "pending";
  if (snapshot.stage !== "ended") {
    return {
      title: `Allocation ${stageTitle(snapshot.stage)}`,
      summary: [
        `Provider: ${provider}`,
        `Fallback used: ${snapshot.fallbackUsed === true ? "yes" : "no"}`,
        `Cleanup: ${snapshot.cleanupResult ?? "not started"}`,
      ].join("\n\n"),
    };
  }

  return {
    title: `Allocation ${snapshot.workloadOutcome}`,
    summary: [
      `Provider: ${provider}`,
      `Duration: ${snapshot.durationSeconds ?? 0} seconds`,
      `Estimated cost: $${((snapshot.estimatedCostUsdCents ?? 0) / 100).toFixed(2)}`,
      `Fallback used: ${snapshot.fallbackUsed === true ? "yes" : "no"}`,
      `Cleanup: ${snapshot.cleanupResult}`,
    ].join("\n\n"),
  };
}

function conclusionFor(
  snapshot: SwitchyardCheckRunSnapshot,
): "cancelled" | "failure" | "success" | "timed_out" {
  if (snapshot.cleanupResult === "failed" || snapshot.workloadOutcome === "failed") {
    return "failure";
  }
  if (snapshot.workloadOutcome === "cancelled") {
    return "cancelled";
  }
  if (snapshot.workloadOutcome === "timed-out") {
    return "timed_out";
  }
  return "success";
}

function verifyPublishedCheckRun(
  value: unknown,
  snapshot: SwitchyardCheckRunSnapshot,
  appSlug: string,
  expectedStatus: "completed" | "in_progress",
): string {
  const check = remoteRecord(value);
  const app = remoteRecord(check.app);
  const checkRunId = remoteGitHubId(check.id);
  if (
    check.name !== SWITCHYARD_CHECK_RUN_NAME ||
    check.external_id !== snapshot.allocationId ||
    requireFullCommitSha(check.head_sha) !== snapshot.headSha ||
    app.slug !== appSlug ||
    check.status !== expectedStatus
  ) {
    throw GitHubRequestError.invalidResponse("check-run-response-mismatch");
  }
  if (expectedStatus === "completed" && check.conclusion !== conclusionFor(snapshot)) {
    throw GitHubRequestError.invalidResponse("check-run-conclusion-mismatch");
  }
  return checkRunId;
}

function remoteRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw GitHubRequestError.invalidResponse("check-run-response-shape-invalid");
  }
  return value as Record<string, unknown>;
}

function remoteGitHubId(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw GitHubRequestError.invalidResponse("check-run-id-shape-invalid");
  }
  return requirePositiveDecimalString(String(value), "checkRun.id");
}

function stageTitle(stage: SwitchyardCheckRunSnapshot["stage"]): string {
  return stage.replaceAll("-", " ");
}
