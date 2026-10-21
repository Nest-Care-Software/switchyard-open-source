import type { TokenCredential } from "@azure/core-auth";
import {
  acceptedCheckRunSnapshot,
  AllocationLedgerError,
  type AllocationControlLedger,
  type ApprovedBranchEvidenceStore,
  lifecycleCheckRunSnapshot,
  type ReconcilerHeartbeatStore,
} from "@switchyard/core";
import {
  CachedGitHubOidcJwtVerifier,
  createAllocationHttpHandler,
  DualAllocationRequestProofVerifier,
  type EasyAuthAncillaryClaimTypes,
  EasyAuthEntraClientProofVerifier,
  type EasyAuthSecurityClaimTypes,
  type AcceptedCheckRunPort,
  type AllocationAdmissionPlanner,
  type AzureProvisioningDispatchPort,
  type ControllerDependencyHealthPort,
  type PostTrustAllocationStateProvider,
  PortableAllocationService,
} from "@switchyard/controller";
import {
  DurableCheckRunCreationCoordinator,
  GitHubAppTokenBroker,
  GitHubOperationClientFactory,
  GitHubTrustVerifier,
  PRODUCTION_APPROVED_WORKLOAD_MAPPINGS,
  SwitchyardCheckRunReporter,
} from "@switchyard/github";
import type { LifecycleVisibilityPort } from "@switchyard/reconciler";

import type { AdmissionRuntimeConfig } from "./config.js";
import type { AdmissionRuntime } from "./runtime.js";

const WORKLOAD_REPOSITORY = Object.freeze({ owner: "example-org", name: "example-workload" });
const WORKLOAD_REPOSITORY_ID = "900000002";
const OWNER_ACTOR_ID = "900000001";
const MAX_DOPPLER_RESPONSE_BYTES = 256 * 1024;

export interface AdmissionCompositionResult {
  readonly clients: GitHubOperationClientFactory;
  readonly runtime: AdmissionRuntime;
  readonly visibility: LifecycleVisibilityPort;
}

export async function createAdmissionRuntime(options: {
  readonly config: AdmissionRuntimeConfig;
  readonly credential: TokenCredential;
  readonly azureDispatch: AzureProvisioningDispatchPort;
  readonly ledger: AllocationControlLedger & ApprovedBranchEvidenceStore & ReconcilerHeartbeatStore;
  readonly runtimeInstanceId: string;
}): Promise<AdmissionCompositionResult> {
  const config = options.config;
  const credentialProvider = new DopplerGitHubPrivateKeyProvider({
    config: config.doppler,
    credential: options.credential,
  });
  const tokenBroker = new GitHubAppTokenBroker({
    configuration: {
      clientId: config.github.appClientId,
      installationId: config.github.appInstallationId,
      workloadRepositoryId: WORKLOAD_REPOSITORY_ID,
      switchyardRepositoryId: config.github.switchyardRepositoryId,
    },
    credentialProvider,
  });
  const clients = new GitHubOperationClientFactory({ tokenBroker });
  const reporter = new SwitchyardCheckRunReporter({
    appSlug: config.github.appSlug,
    clients,
    creationCoordinator: new DurableCheckRunCreationCoordinator({
      leaseOwner: options.runtimeInstanceId,
      store: options.ledger,
    }),
    repository: WORKLOAD_REPOSITORY,
  });
  const entra = new EasyAuthEntraClientProofVerifier({
    ancillaryClaimTypes: parseClaimMapping(
      config.entra.ancillaryClaimsJson,
    ) as unknown as EasyAuthAncillaryClaimTypes,
    expectedApiAudience: config.entra.apiAudience,
    expectedAuthenticationType: config.entra.expectedAuthenticationType,
    expectedClientApplicationId: config.entra.clientApplicationId,
    expectedDedicatedRole: config.entra.dedicatedRole,
    expectedIdentityTypeValue: config.entra.expectedIdentityType,
    expectedIssuer: config.entra.expectedIssuer,
    expectedNameClaimType: config.entra.expectedNameClaimType,
    expectedTenantId: config.entra.tenantId,
    expectedTokenVersion: config.entra.tokenVersion,
    securityClaimTypes: parseClaimMapping(
      config.entra.securityClaimsJson,
    ) as unknown as EasyAuthSecurityClaimTypes,
  });
  const githubProof = new CachedGitHubOidcJwtVerifier({
    audience: config.github.proofAudience,
    cacheSeconds: 300,
    calledWorkflow: {
      commitSha: config.github.reusableWorkflowSha,
      path: ".github/workflows/allocate-runner.yml",
      repository: "example-org/switchyard",
    },
    callerWorkflow: {
      actorLogin: config.github.actorLogin,
      path: ".github/workflows/ci.yml",
      ref: "refs/heads/main",
      repository: "example-org/example-workload",
      repositoryId: WORKLOAD_REPOSITORY_ID,
      subject: `repo:example-org@${config.github.organisationId}/example-workload@${WORKLOAD_REPOSITORY_ID}:ref:refs/heads/main`,
      workflowName: "CI",
    },
    clockSkewSeconds: 30,
    fetch: new FixedGitHubOidcFetch(),
    fetchTimeoutMilliseconds: 5_000,
    maxTokenLifetimeSeconds: 600,
    ownerActorId: OWNER_ACTOR_ID,
    repositoryOwnerId: config.github.organisationId,
  });
  const trust = new GitHubTrustVerifier({
    approvedMappings: PRODUCTION_APPROVED_WORKLOAD_MAPPINGS,
    branchEvidence: options.ledger,
    clients,
  });
  const security = new DualAllocationRequestProofVerifier({ entra, github: githubProof, trust });
  const service = new PortableAllocationService({
    admission: new FixedV1AdmissionPlanner(config),
    azureDispatch: options.azureDispatch,
    checkRunAppSlug: config.checkRunAppSlug,
    checkRuns: new AcceptedCheckRunAdapter(reporter),
    dependencyHealth: healthyAdmissionDependencies(),
    security,
    state: postTrustState(options.ledger),
  });
  return {
    clients,
    runtime: { allocate: createAllocationHttpHandler(service) },
    visibility: new LifecycleCheckRunVisibility({ ledger: options.ledger, reporter }),
  };
}

class AcceptedCheckRunAdapter implements AcceptedCheckRunPort {
  readonly #reporter: SwitchyardCheckRunReporter;

  constructor(reporter: SwitchyardCheckRunReporter) {
    this.#reporter = reporter;
  }

  async ensureAccepted(input: Parameters<AcceptedCheckRunPort["ensureAccepted"]>[0]) {
    const delivered = await this.#reporter.publish(
      input.allocation.checkRunCreation.delivery,
      acceptedCheckRunSnapshot(input.allocation),
    );
    if (delivered.lifecycle.phase === "not-created") return { outcome: "deferred" as const };
    return { checkRunId: delivered.lifecycle.checkRunId, outcome: "completed" as const };
  }
}

export class LifecycleCheckRunVisibility implements LifecycleVisibilityPort {
  readonly #ledger: AllocationControlLedger;
  readonly #reporter: SwitchyardCheckRunReporter;

  constructor(options: {
    readonly ledger: AllocationControlLedger;
    readonly reporter: SwitchyardCheckRunReporter;
  }) {
    this.#ledger = options.ledger;
    this.#reporter = options.reporter;
  }

  async reconcile(allocationId: string, options: { readonly signal: AbortSignal }): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (options.signal.aborted) throw options.signal.reason;
      const allocation = await this.#ledger.getAllocation(allocationId);
      if (allocation === undefined) throw new TypeError("allocation is missing");
      const next = await this.#reporter.publish(
        allocation.checkRunCreation.delivery,
        lifecycleCheckRunSnapshot(allocation),
        { signal: options.signal },
      );
      if (next === allocation.checkRunCreation.delivery) return;
      try {
        await this.#ledger.updateAllocationState({
          allocationId,
          expectedRevision: allocation.revision,
          patch: { checkRunDelivery: next },
          updatedAt: new Date().toISOString(),
        });
        return;
      } catch (error) {
        if (
          !(error instanceof AllocationLedgerError) ||
          error.code !== "optimistic-concurrency-conflict"
        ) {
          throw error;
        }
      }
    }
    throw new TypeError("Check Run delivery ETag retries were exhausted");
  }
}

class FixedV1AdmissionPlanner implements AllocationAdmissionPlanner {
  readonly #config: AdmissionRuntimeConfig;

  constructor(config: AdmissionRuntimeConfig) {
    this.#config = config;
  }

  async planAzure(input: Parameters<AllocationAdmissionPlanner["planAzure"]>[0]) {
    const accepted = Date.parse(input.allocationCreatedAt);
    const computeDeadline = new Date(accepted + 40 * 60_000).toISOString();
    const absoluteExpiry = new Date(accepted + 45 * 60_000).toISOString();
    const latestSafeStart = new Date(
      Date.parse(computeDeadline) - (input.trust.workload.timeoutMinutes + 5) * 60_000,
    ).toISOString();
    if (input.attemptedAt > latestSafeStart) throw new TypeError("Azure admission is too late");
    return {
      deadlines: { absoluteExpiry, computeDeadline, latestSafeStart },
      worstCaseCostUsdCents:
        input.trust.workload.profile === "linux-x64-large"
          ? this.#config.costs.azureLarge
          : this.#config.costs.azureStandard,
    };
  }

  async planBlacksmith(input: Parameters<AllocationAdmissionPlanner["planBlacksmith"]>[0]) {
    return {
      worstCaseCostUsdCents:
        input.trust.workload.profile === "linux-x64-large"
          ? this.#config.costs.blacksmithLarge
          : this.#config.costs.blacksmithStandard,
    };
  }
}

class FixedGitHubOidcFetch {
  async fetch(
    url: string,
    init: { readonly redirect: "error"; readonly signal: AbortSignal },
  ): Promise<Response> {
    if (
      url !== "https://token.actions.githubusercontent.com/.well-known/openid-configuration" &&
      url !== "https://token.actions.githubusercontent.com/.well-known/jwks"
    ) {
      throw new TypeError("GitHub OIDC host or path is not approved");
    }
    return fetch(url, { method: "GET", redirect: init.redirect, signal: init.signal });
  }
}

class DopplerGitHubPrivateKeyProvider {
  readonly #config: AdmissionRuntimeConfig["doppler"];
  readonly #credential: TokenCredential;

  constructor(options: {
    readonly config: AdmissionRuntimeConfig["doppler"];
    readonly credential: TokenCredential;
  }) {
    this.#config = options.config;
    this.#credential = options.credential;
  }

  async loadPrivateKey(): Promise<string> {
    let assertion = "";
    let dopplerToken = "";
    try {
      const access = await this.#credential.getToken(this.#config.oidcAudience);
      if (access === null) throw new TypeError("Doppler identity proof is unavailable");
      assertion = access.token;
      const exchange = await boundedDopplerJson("https://api.doppler.com/v3/auth/oidc", {
        body: JSON.stringify({ token: assertion }),
        method: "POST",
      });
      dopplerToken = requiredResponseString(exchange, "token", 16 * 1024);
      const secrets = await boundedDopplerJson(
        `https://api.doppler.com/v3/configs/config/secrets/download?project=${encodeURIComponent(this.#config.project)}&config=${encodeURIComponent(this.#config.config)}&format=json`,
        {
          headers: { authorization: `Bearer ${dopplerToken}` },
          method: "GET",
        },
      );
      return requiredResponseString(secrets, this.#config.githubPrivateKeyName, 64 * 1024);
    } finally {
      assertion = "";
      dopplerToken = "";
    }
  }
}

async function boundedDopplerJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  if (!url.startsWith("https://api.doppler.com/v3/")) throw new TypeError("Doppler URL is invalid");
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...init.headers },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new TypeError("Doppler request failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOPPLER_RESPONSE_BYTES)
    throw new TypeError("Doppler response too large");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Doppler response invalid");
  }
  return value as Record<string, unknown>;
}

function requiredResponseString(
  value: Record<string, unknown>,
  key: string,
  maximum: number,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > maximum) {
    throw new TypeError("Doppler response is missing an approved value");
  }
  return candidate;
}

function parseClaimMapping(value: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("claim mapping is invalid");
  }
  return parsed as Record<string, string>;
}

function postTrustState(
  ledger: AllocationControlLedger & ReconcilerHeartbeatStore,
): PostTrustAllocationStateProvider {
  return { open: async () => ({ heartbeat: ledger, ledger }) };
}

function healthyAdmissionDependencies(): ControllerDependencyHealthPort {
  return {
    read: async () => ({
      authoritativeLedger: "available",
      doppler: "available",
      switchyardApi: "available",
    }),
  };
}
