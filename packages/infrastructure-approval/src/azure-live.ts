import { randomUUID, timingSafeEqual } from "node:crypto";

import { parseXML } from "@azure/core-xml";
import { parseStrictJson, requireExactKeys, requireRecord } from "@switchyard/core";

import {
  type ApplyIntentReceipt,
  type ApplyIntentReceiptPort,
  type ApplyLeaseEvidence,
  type AuthoritativeApplyLeasePort,
  type AuthoritativeStatePort,
  INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP,
  type PrivatePlanReceiptPort,
  type StartedApplyIntentReceipt,
  validateIntentReceipt,
} from "./apply-engine.js";
import {
  type BackendIdentity,
  InfrastructureApprovalError,
  type InfrastructureApprovalPolicy,
  type InfrastructureIdentitySession,
  sha256,
  sha256Bytes,
  stateEtag,
  validateBackend,
  validatePolicy,
  verifyIdentitySession,
} from "./contracts.js";
import type { PlannerStateReadPort } from "./opentofu.js";
import {
  createCanonicalInitialState,
  requireCanonicalInitialState,
  stateIdentityFromOpenTofuState,
} from "./state.js";

const AZURE_STORAGE_SCOPE = "https://storage.azure.com/.default";
const AZURE_STORAGE_API_VERSION = "2025-05-05";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PLAN_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_CONTROL_BYTES = 128 * 1024;
const MAX_HISTORY_LIST_BYTES = 256 * 1024;
const MAX_HISTORY_LIST_PAGES = 8;
const MAX_HISTORY_LIST_RESULTS = 100;
const MAX_HISTORY_LIST_TOTAL_RESULTS = MAX_HISTORY_LIST_PAGES * MAX_HISTORY_LIST_RESULTS;
const MAX_HISTORY_MARKER_LENGTH = 4_096;
const HISTORY_LIST_INCLUDE =
  "snapshots,uncommittedblobs,deleted,versions,deletedwithversions" as const;
const AZURE_STORAGE_ERROR_CLASSIFICATIONS = Object.freeze({
  ConditionHeadersNotSupported: "condition-headers-not-supported",
  EmptyMetadataKey: "empty-metadata-key",
  InvalidAuthenticationInfo: "invalid-authentication-info",
  InvalidHeaderValue: "invalid-header-value",
  InvalidHttpVerb: "invalid-http-verb",
  InvalidInput: "invalid-input",
  InvalidMd5: "invalid-md5",
  InvalidMetadata: "invalid-metadata",
  InvalidQueryParameterValue: "invalid-query-parameter-value",
  InvalidResourceName: "invalid-resource-name",
  InvalidUri: "invalid-uri",
  InvalidXmlDocument: "invalid-xml-document",
  InvalidXmlNodeValue: "invalid-xml-node-value",
  Md5Mismatch: "md5-mismatch",
  MetadataTooLarge: "metadata-too-large",
  MissingRequiredHeader: "missing-required-header",
  MissingRequiredQueryParameter: "missing-required-query-parameter",
  MissingRequiredXmlNode: "missing-required-xml-node",
  MultipleConditionHeadersNotSupported: "multiple-condition-headers-not-supported",
  OutOfRangeInput: "out-of-range-input",
  OutOfRangeQueryParameterValue: "out-of-range-query-parameter-value",
  RequestUrlFailedToParse: "request-url-failed-to-parse",
  UnsupportedHeader: "unsupported-header",
  UnsupportedQueryParameter: "unsupported-query-parameter",
  UnsupportedXmlNode: "unsupported-xml-node",
} as const);
const APPLY_LEASE_BLOB = "locks/infrastructure-apply.lock";
const INITIAL_STATE_RECORD_BLOB = "foundation/initial-state.json";

export interface AzureApprovalStorageConfig {
  readonly applyControlContainerName: "apply-control";
  readonly receiptContainerName: "plan-receipts";
  readonly receiptStorageAccountName: string;
  readonly stateBackend: BackendIdentity;
}

interface AzureBlobRequest {
  readonly accountName: string;
  readonly blobName: string;
  readonly body?: Uint8Array;
  readonly containerName: string;
  readonly expectedStatuses: readonly number[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxResponseBytes: number;
  readonly method: "GET" | "HEAD" | "PUT";
  readonly query?: string;
  readonly session: InfrastructureIdentitySession;
}

interface AzureBlobResponse {
  readonly bytes: Uint8Array;
  readonly headers: Headers;
  readonly status: number;
}

interface AzureAuthenticatedRequest {
  readonly body?: Uint8Array;
  readonly expectedStatuses: readonly number[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxResponseBytes: number;
  readonly method: "GET" | "HEAD" | "PUT";
  readonly session: InfrastructureIdentitySession;
  readonly url: string;
}

/** Bounded Azure Blob REST transport which can authenticate only through its explicit session. */
export class AzureApprovalBlobTransport {
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;

  constructor(
    options: {
      readonly fetch?: typeof globalThis.fetch;
      readonly now?: () => number;
    } = {},
  ) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async request(input: AzureBlobRequest): Promise<AzureBlobResponse> {
    const accountName = storageAccountName(input.accountName, "azure.accountName");
    const containerName = storageContainerName(input.containerName, "azure.containerName");
    const blobPath = blobName(input.blobName);
    if (input.query !== undefined && input.query !== "?comp=lease") {
      throw new InfrastructureApprovalError("azure-query-invalid");
    }
    return this.#authenticatedRequest({
      ...(input.body === undefined ? {} : { body: input.body }),
      expectedStatuses: input.expectedStatuses,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      maxResponseBytes: input.maxResponseBytes,
      method: input.method,
      session: input.session,
      url: `https://${accountName}.blob.core.windows.net/${containerName}/${blobPath}${input.query ?? ""}`,
    });
  }

  async listBlobHistoryPage(input: {
    readonly accountName: string;
    readonly containerName: string;
    readonly marker: string | null;
    readonly session: InfrastructureIdentitySession;
  }): Promise<AzureBlobResponse> {
    const accountName = storageAccountName(input.accountName, "azure.accountName");
    const containerName = storageContainerName(input.containerName, "azure.containerName");
    if (
      input.marker !== null &&
      (typeof input.marker !== "string" ||
        input.marker.length < 1 ||
        input.marker.length > MAX_HISTORY_MARKER_LENGTH ||
        containsControlCharacter(input.marker))
    ) {
      throw new InfrastructureApprovalError("azure-history-marker-invalid");
    }
    const query = new URLSearchParams({
      comp: "list",
      include: HISTORY_LIST_INCLUDE,
      maxresults: String(MAX_HISTORY_LIST_RESULTS),
      restype: "container",
    });
    if (input.marker !== null) query.set("marker", input.marker);
    return this.#authenticatedRequest({
      expectedStatuses: [200],
      headers: { accept: "application/xml" },
      maxResponseBytes: MAX_HISTORY_LIST_BYTES,
      method: "GET",
      session: input.session,
      url: `https://${accountName}.blob.core.windows.net/${containerName}?${query.toString()}`,
    });
  }

  async #authenticatedRequest(input: AzureAuthenticatedRequest): Promise<AzureBlobResponse> {
    if (
      !Array.isArray(input.expectedStatuses) ||
      input.expectedStatuses.length < 1 ||
      input.expectedStatuses.some(
        (status) => !Number.isInteger(status) || status < 100 || status > 599,
      )
    ) {
      throw new InfrastructureApprovalError("azure-expected-status-invalid");
    }
    if (
      !Number.isSafeInteger(input.maxResponseBytes) ||
      input.maxResponseBytes < 0 ||
      input.maxResponseBytes > MAX_PLAN_RECEIPT_BYTES
    ) {
      throw new InfrastructureApprovalError("azure-response-bound-invalid");
    }
    let token: Awaited<ReturnType<InfrastructureIdentitySession["credential"]["getToken"]>> = null;
    let response: Response;
    try {
      token = await input.session.credential.getToken(AZURE_STORAGE_SCOPE);
      if (
        token === null ||
        typeof token.token !== "string" ||
        token.token.length < 32 ||
        token.token.length > 16_384 ||
        !Number.isFinite(token.expiresOnTimestamp) ||
        token.expiresOnTimestamp <= this.#now() + 30_000
      ) {
        throw new InfrastructureApprovalError("azure-session-token-invalid");
      }
      response = await this.#fetch(input.url, {
        ...(input.body === undefined ? {} : { body: Uint8Array.from(input.body) }),
        headers: {
          authorization: `Bearer ${token.token}`,
          "x-ms-date": new Date(this.#now()).toUTCString(),
          "x-ms-version": AZURE_STORAGE_API_VERSION,
          ...input.headers,
        },
        method: input.method,
        redirect: "error",
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof InfrastructureApprovalError) throw error;
      throw new InfrastructureApprovalError("azure-storage-network-unavailable");
    } finally {
      token = null;
    }
    if (!input.expectedStatuses.includes(response.status)) {
      const classification =
        response.status === 400 ? azureStorageErrorClassification(response.headers) : null;
      await response.body?.cancel();
      throw new InfrastructureApprovalError(
        `azure-storage-status-${response.status}${classification === null ? "" : `-${classification}`}`,
      );
    }
    return Object.freeze({
      bytes:
        input.method === "HEAD"
          ? new Uint8Array()
          : await readBoundedBytes(response, input.maxResponseBytes),
      headers: response.headers,
      status: response.status,
    });
  }
}

function azureStorageErrorClassification(headers: Headers): string {
  const errorCode = headers.get("x-ms-error-code");
  if (errorCode === null) return "error-code-absent";
  return (
    AZURE_STORAGE_ERROR_CLASSIFICATIONS[
      errorCode as keyof typeof AZURE_STORAGE_ERROR_CLASSIFICATIONS
    ] ?? "error-code-unreviewed"
  );
}

export class LiveAzurePlannerStatePort implements PlannerStateReadPort {
  readonly #config: AzureApprovalStorageConfig;
  readonly #policy: InfrastructureApprovalPolicy;
  readonly #transport: AzureApprovalBlobTransport;

  constructor(options: {
    readonly config: AzureApprovalStorageConfig;
    readonly policy: InfrastructureApprovalPolicy;
    readonly transport: AzureApprovalBlobTransport;
  }) {
    validateStorageConfig(options.config, options.policy);
    this.#config = options.config;
    this.#policy = options.policy;
    this.#transport = options.transport;
  }

  async readIdentity(input: {
    readonly backend: BackendIdentity;
    readonly plannerSession: InfrastructureIdentitySession & { readonly identity: "planner" };
  }) {
    requireExactBackend(input.backend, this.#config.stateBackend);
    requireAzureSession(input.plannerSession, this.#policy, ["planner"]);
    return readState(this.#transport, input.backend, input.plannerSession);
  }
}

export class LiveAzureAuthoritativeStatePort implements AuthoritativeStatePort {
  readonly #config: AzureApprovalStorageConfig;
  readonly #policy: InfrastructureApprovalPolicy;
  readonly #transport: AzureApprovalBlobTransport;

  constructor(options: {
    readonly config: AzureApprovalStorageConfig;
    readonly policy: InfrastructureApprovalPolicy;
    readonly transport: AzureApprovalBlobTransport;
  }) {
    validateStorageConfig(options.config, options.policy);
    this.#config = options.config;
    this.#policy = options.policy;
    this.#transport = options.transport;
  }

  async readIdentity(input: {
    readonly backend: BackendIdentity;
    readonly session: InfrastructureIdentitySession;
  }) {
    requireExactBackend(input.backend, this.#config.stateBackend);
    requireAzureSession(input.session, this.#policy, ["bootstrap-applier", "foundation-applier"]);
    return readState(this.#transport, input.backend, input.session);
  }

  async readIdentityUnderLease(input: {
    readonly backend: BackendIdentity;
    readonly lease: ApplyLeaseEvidence;
    readonly session: InfrastructureIdentitySession;
  }) {
    requireLease(input.lease);
    return this.readIdentity(input);
  }
}

export class LiveAzurePrivatePlanReceiptPort implements PrivatePlanReceiptPort {
  readonly #config: AzureApprovalStorageConfig;
  readonly #policy: InfrastructureApprovalPolicy;
  readonly #transport: AzureApprovalBlobTransport;

  constructor(options: {
    readonly config: AzureApprovalStorageConfig;
    readonly policy: InfrastructureApprovalPolicy;
    readonly transport: AzureApprovalBlobTransport;
  }) {
    validateStorageConfig(options.config, options.policy);
    this.#config = options.config;
    this.#policy = options.policy;
    this.#transport = options.transport;
  }

  async ensurePrivateReceipt(input: {
    readonly archiveBytes: Uint8Array;
    readonly contentAddressedKey: string;
    readonly session: InfrastructureIdentitySession;
  }) {
    requireAzureSession(input.session, this.#policy, ["bootstrap-applier", "foundation-applier"]);
    if (!(input.archiveBytes instanceof Uint8Array) || input.archiveBytes.byteLength < 1) {
      throw new InfrastructureApprovalError("plan-receipt-bytes-invalid");
    }
    const match = /^plans\/([a-f0-9]{64})\/([a-f0-9]{64})\.zip$/.exec(input.contentAddressedKey);
    if (match === null || match[2] !== sha256Bytes(input.archiveBytes)) {
      throw new InfrastructureApprovalError("plan-receipt-key-mismatch");
    }
    const put = await this.#transport.request({
      accountName: this.#config.receiptStorageAccountName,
      blobName: input.contentAddressedKey,
      body: input.archiveBytes,
      containerName: this.#config.receiptContainerName,
      expectedStatuses: [201, 412],
      headers: {
        "content-type": "application/zip",
        "if-none-match": "*",
        "x-ms-blob-type": "BlockBlob",
        "x-ms-meta-switchyard_sha256": match[2],
      },
      maxResponseBytes: 0,
      method: "PUT",
      session: input.session,
    });
    const observed = await this.#transport.request({
      accountName: this.#config.receiptStorageAccountName,
      blobName: input.contentAddressedKey,
      containerName: this.#config.receiptContainerName,
      expectedStatuses: [200],
      maxResponseBytes: MAX_PLAN_RECEIPT_BYTES,
      method: "GET",
      session: input.session,
    });
    const etag = requiredEtag(observed.headers);
    const sha = sha256Bytes(observed.bytes);
    if (
      sha !== match[2] ||
      observed.headers.get("x-ms-meta-switchyard_sha256") !== sha ||
      !equalBytes(observed.bytes, input.archiveBytes)
    ) {
      throw new InfrastructureApprovalError("private-receipt-mismatch");
    }
    const modified = httpInstant(observed.headers, "last-modified");
    return Object.freeze({
      bytes: observed.bytes,
      contentAddressedKey: input.contentAddressedKey,
      created: put.status === 201,
      createdAt: modified,
      etag,
      publishedAt: modified,
      sha256: sha,
    });
  }
}

export class LiveAzureApplyLeasePort implements AuthoritativeApplyLeasePort {
  readonly #config: AzureApprovalStorageConfig;
  readonly #policy: InfrastructureApprovalPolicy;
  readonly #transport: AzureApprovalBlobTransport;

  constructor(options: {
    readonly config: AzureApprovalStorageConfig;
    readonly policy: InfrastructureApprovalPolicy;
    readonly transport: AzureApprovalBlobTransport;
  }) {
    validateStorageConfig(options.config, options.policy);
    this.#config = options.config;
    this.#policy = options.policy;
    this.#transport = options.transport;
  }

  async withLease<T>(input: {
    readonly key: typeof INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP;
    readonly session: InfrastructureIdentitySession;
    readonly work: (lease: ApplyLeaseEvidence) => Promise<T>;
  }): Promise<T> {
    if (input.key !== INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP) {
      throw new InfrastructureApprovalError("apply-lease-key-invalid");
    }
    requireAzureSession(input.session, this.#policy, ["bootstrap-applier", "foundation-applier"]);
    await this.#transport.request({
      accountName: this.#config.stateBackend.storageAccountName,
      blobName: APPLY_LEASE_BLOB,
      body: new Uint8Array(),
      containerName: this.#config.applyControlContainerName,
      expectedStatuses: [201, 412],
      headers: { "if-none-match": "*", "x-ms-blob-type": "BlockBlob" },
      maxResponseBytes: 0,
      method: "PUT",
      session: input.session,
    });
    const leaseId = randomUUID();
    const acquired = await this.#transport.request({
      accountName: this.#config.stateBackend.storageAccountName,
      blobName: APPLY_LEASE_BLOB,
      containerName: this.#config.applyControlContainerName,
      expectedStatuses: [201, 409],
      headers: {
        "x-ms-lease-action": "acquire",
        "x-ms-lease-duration": "-1",
        "x-ms-proposed-lease-id": leaseId,
      },
      maxResponseBytes: 0,
      method: "PUT",
      query: "?comp=lease",
      session: input.session,
    });
    if (acquired.status !== 201 || acquired.headers.get("x-ms-lease-id") !== leaseId) {
      throw new InfrastructureApprovalError("apply-lease-unavailable");
    }
    const evidence = Object.freeze({
      acquired: true as const,
      key: INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP,
      leaseId,
    });
    const release = async (): Promise<void> => {
      await this.#transport.request({
        accountName: this.#config.stateBackend.storageAccountName,
        blobName: APPLY_LEASE_BLOB,
        containerName: this.#config.applyControlContainerName,
        expectedStatuses: [200],
        headers: { "x-ms-lease-action": "release", "x-ms-lease-id": leaseId },
        maxResponseBytes: 0,
        method: "PUT",
        query: "?comp=lease",
        session: input.session,
      });
    };
    let outcome:
      | { readonly ok: true; readonly value: T }
      | { readonly error: unknown; readonly ok: false };
    try {
      outcome = { ok: true, value: await input.work(evidence) };
    } catch (error) {
      outcome = { error, ok: false };
    }
    let releaseError: unknown;
    try {
      await release();
    } catch (error) {
      releaseError = error;
    }
    if (!outcome.ok) {
      if (releaseError !== undefined) {
        throw new AggregateError(
          [outcome.error, releaseError],
          "apply-work-and-lease-release-failed",
        );
      }
      throw outcome.error;
    }
    if (releaseError !== undefined) throw releaseError;
    return outcome.value;
  }
}

export class LiveAzureApplyIntentReceiptPort implements ApplyIntentReceiptPort {
  readonly #config: AzureApprovalStorageConfig;
  readonly #policy: InfrastructureApprovalPolicy;
  readonly #transport: AzureApprovalBlobTransport;

  constructor(options: {
    readonly config: AzureApprovalStorageConfig;
    readonly policy: InfrastructureApprovalPolicy;
    readonly transport: AzureApprovalBlobTransport;
  }) {
    validateStorageConfig(options.config, options.policy);
    this.#config = options.config;
    this.#policy = options.policy;
    this.#transport = options.transport;
  }

  async read(input: {
    readonly planDigest: string;
    readonly session: InfrastructureIdentitySession;
  }) {
    requireAzureSession(input.session, this.#policy, ["bootstrap-applier", "foundation-applier"]);
    const planDigest = sha256(input.planDigest, "intent.planDigest");
    const observed = await this.#readBlob(planDigest, input.session);
    return observed?.receipt ?? null;
  }

  async createStarted(input: {
    readonly proposed: StartedApplyIntentReceipt;
    readonly session: InfrastructureIdentitySession;
  }) {
    requireAzureSession(input.session, this.#policy, ["bootstrap-applier", "foundation-applier"]);
    validateIntentReceipt(input.proposed);
    const bytes = intentBytes(input.proposed);
    const created = await this.#transport.request({
      accountName: this.#config.stateBackend.storageAccountName,
      blobName: intentBlob(input.proposed.planDigest),
      body: bytes,
      containerName: this.#config.applyControlContainerName,
      expectedStatuses: [201, 412],
      headers: {
        "content-type": "application/json",
        "if-none-match": "*",
        "x-ms-blob-type": "BlockBlob",
      },
      maxResponseBytes: 0,
      method: "PUT",
      session: input.session,
    });
    const stored = await this.#readBlob(input.proposed.planDigest, input.session);
    if (stored === null) throw new InfrastructureApprovalError("intent-create-proof-missing");
    return Object.freeze({
      outcome: created.status === 201 ? ("created" as const) : ("exists" as const),
      receipt: stored.receipt,
    });
  }

  async replace(input: {
    readonly expectedReceiptDigest: string;
    readonly next: ApplyIntentReceipt;
    readonly planDigest: string;
    readonly session: InfrastructureIdentitySession;
  }) {
    requireAzureSession(input.session, this.#policy, ["bootstrap-applier", "foundation-applier"]);
    validateIntentReceipt(input.next);
    const planDigest = sha256(input.planDigest, "intent.planDigest");
    if (input.next.planDigest !== planDigest) {
      throw new InfrastructureApprovalError("intent-plan-digest-mismatch");
    }
    const current = await this.#readBlob(planDigest, input.session);
    if (current === null || current.receipt.receiptDigest !== input.expectedReceiptDigest) {
      throw new InfrastructureApprovalError("intent-conditional-replace-conflict");
    }
    const response = await this.#transport.request({
      accountName: this.#config.stateBackend.storageAccountName,
      blobName: intentBlob(planDigest),
      body: intentBytes(input.next),
      containerName: this.#config.applyControlContainerName,
      expectedStatuses: [201, 412],
      headers: {
        "content-type": "application/json",
        "if-match": current.etag,
        "x-ms-blob-type": "BlockBlob",
      },
      maxResponseBytes: 0,
      method: "PUT",
      session: input.session,
    });
    if (response.status !== 201) {
      throw new InfrastructureApprovalError("intent-conditional-replace-conflict");
    }
    const stored = await this.#readBlob(planDigest, input.session);
    if (stored === null || stored.receipt.receiptDigest !== input.next.receiptDigest) {
      throw new InfrastructureApprovalError("intent-replace-proof-mismatch");
    }
    return stored.receipt;
  }

  async #readBlob(planDigest: string, session: InfrastructureIdentitySession) {
    const response = await this.#transport.request({
      accountName: this.#config.stateBackend.storageAccountName,
      blobName: intentBlob(planDigest),
      containerName: this.#config.applyControlContainerName,
      expectedStatuses: [200, 404],
      maxResponseBytes: MAX_CONTROL_BYTES,
      method: "GET",
      session,
    });
    if (response.status === 404) return null;
    const receipt = parseIntent(response.bytes);
    if (receipt.planDigest !== planDigest) {
      throw new InfrastructureApprovalError("intent-storage-key-mismatch");
    }
    return Object.freeze({ etag: requiredEtag(response.headers), receipt });
  }
}

export class LiveAzureInitialStateBootstrap {
  readonly #config: AzureApprovalStorageConfig;
  readonly #lineage: () => string;
  readonly #now: () => Date;
  readonly #policy: InfrastructureApprovalPolicy;
  readonly #transport: AzureApprovalBlobTransport;

  constructor(options: {
    readonly config: AzureApprovalStorageConfig;
    readonly lineage?: () => string;
    readonly now?: () => Date;
    readonly policy: InfrastructureApprovalPolicy;
    readonly transport: AzureApprovalBlobTransport;
  }) {
    validateStorageConfig(options.config, options.policy);
    this.#config = options.config;
    this.#lineage = options.lineage ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#policy = options.policy;
    this.#transport = options.transport;
  }

  async initialise(session: InfrastructureIdentitySession) {
    requireAzureSession(session, this.#policy, ["bootstrap-applier"]);
    await assertNoBlobHistory(
      this.#transport,
      this.#config.stateBackend.storageAccountName,
      this.#config.stateBackend.containerName,
      this.#config.stateBackend.key,
      session,
    );
    const canonical = createCanonicalInitialState(this.#lineage());
    requireCanonicalInitialState(canonical.bytes);
    const put = await this.#transport.request({
      accountName: this.#config.stateBackend.storageAccountName,
      blobName: this.#config.stateBackend.key,
      body: canonical.bytes,
      containerName: this.#config.stateBackend.containerName,
      expectedStatuses: [201, 412],
      headers: {
        "content-type": "application/json",
        "if-none-match": "*",
        "x-ms-blob-type": "BlockBlob",
        "x-ms-meta-switchyard_sha256": canonical.sha256,
      },
      maxResponseBytes: 0,
      method: "PUT",
      session,
    });
    if (put.status !== 201) throw new InfrastructureApprovalError("initial-state-pre-exists");
    return withExclusiveBlobLease({
      accountName: this.#config.stateBackend.storageAccountName,
      blobName: this.#config.stateBackend.key,
      containerName: this.#config.stateBackend.containerName,
      session,
      transport: this.#transport,
      work: async (leaseId) => {
        const state = await readStateBlob(
          this.#transport,
          this.#config.stateBackend,
          session,
          MAX_STATE_BYTES,
          leaseId,
        );
        const identity = requireExactInitialState(state, canonical);
        await assertNoBlobHistory(
          this.#transport,
          this.#config.stateBackend.storageAccountName,
          this.#config.applyControlContainerName,
          INITIAL_STATE_RECORD_BLOB,
          session,
        );
        const recordBytes = new TextEncoder().encode(
          `${JSON.stringify({
            schema_version: 1,
            state_blob: this.#config.stateBackend.key,
            state_sha256: identity.backendStateDigest,
            state_etag: identity.backendStateEtag,
            lineage: identity.lineage,
            serial: identity.serial,
            recorded_at: this.#now().toISOString(),
          })}\n`,
        );
        const recordPut = await this.#transport.request({
          accountName: this.#config.stateBackend.storageAccountName,
          blobName: INITIAL_STATE_RECORD_BLOB,
          body: recordBytes,
          containerName: this.#config.applyControlContainerName,
          expectedStatuses: [201, 412],
          headers: {
            "content-type": "application/json",
            "if-none-match": "*",
            "x-ms-blob-type": "BlockBlob",
          },
          maxResponseBytes: 0,
          method: "PUT",
          session,
        });
        if (recordPut.status !== 201) {
          throw new InfrastructureApprovalError("initial-state-record-pre-exists");
        }
        const recorded = await this.#transport.request({
          accountName: this.#config.stateBackend.storageAccountName,
          blobName: INITIAL_STATE_RECORD_BLOB,
          containerName: this.#config.applyControlContainerName,
          expectedStatuses: [200],
          maxResponseBytes: MAX_CONTROL_BYTES,
          method: "GET",
          session,
        });
        if (!equalBytes(recorded.bytes, recordBytes)) {
          throw new InfrastructureApprovalError("initial-state-record-mismatch");
        }
        const finalState = await readStateBlob(
          this.#transport,
          this.#config.stateBackend,
          session,
          MAX_STATE_BYTES,
          leaseId,
        );
        const finalIdentity = requireExactInitialState(finalState, canonical);
        if (
          finalIdentity.backendStateDigest !== identity.backendStateDigest ||
          finalIdentity.backendStateEtag !== identity.backendStateEtag ||
          finalIdentity.lineage !== identity.lineage ||
          finalIdentity.serial !== 0 ||
          !finalIdentity.managedResourcesEmpty ||
          finalIdentity.managedResourceCount !== 0
        ) {
          throw new InfrastructureApprovalError("initial-state-final-mismatch");
        }
        return Object.freeze({
          identity: finalIdentity,
          recordEtag: requiredEtag(recorded.headers),
        });
      },
    });
  }
}

async function readState(
  transport: AzureApprovalBlobTransport,
  backend: BackendIdentity,
  session: InfrastructureIdentitySession,
) {
  const response = await readStateBlob(transport, backend, session, MAX_STATE_BYTES);
  return stateIdentityFromOpenTofuState(response.bytes, requiredEtag(response.headers));
}

function readStateBlob(
  transport: AzureApprovalBlobTransport,
  backend: BackendIdentity,
  session: InfrastructureIdentitySession,
  maxResponseBytes: number,
  leaseId?: string,
) {
  return transport.request({
    accountName: backend.storageAccountName,
    blobName: backend.key,
    containerName: backend.containerName,
    expectedStatuses: [200],
    ...(leaseId === undefined ? {} : { headers: { "x-ms-lease-id": leaseId } }),
    maxResponseBytes,
    method: "GET",
    session,
  });
}

async function assertNoBlobHistory(
  transport: AzureApprovalBlobTransport,
  accountName: string,
  containerName: string,
  exactBlobName: string,
  session: InfrastructureIdentitySession,
): Promise<void> {
  blobName(exactBlobName);
  const seenMarkers = new Set<string>();
  let marker: string | null = null;
  let resultCount = 0;
  for (let pageNumber = 0; pageNumber < MAX_HISTORY_LIST_PAGES; pageNumber += 1) {
    const response = await transport.listBlobHistoryPage({
      accountName,
      containerName,
      marker,
      session,
    });
    const page = await parseBlobHistoryPage(response, accountName, containerName, marker);
    resultCount += page.names.length;
    if (resultCount > MAX_HISTORY_LIST_TOTAL_RESULTS) {
      throw new InfrastructureApprovalError("azure-history-results-over-limit");
    }
    if (page.names.includes(exactBlobName)) {
      throw new InfrastructureApprovalError("initial-state-history-pre-exists");
    }
    if (page.nextMarker === null) return;
    if (seenMarkers.has(page.nextMarker)) {
      throw new InfrastructureApprovalError("azure-history-marker-repeated");
    }
    seenMarkers.add(page.nextMarker);
    marker = page.nextMarker;
  }
  throw new InfrastructureApprovalError("azure-history-pages-over-limit");
}

async function parseBlobHistoryPage(
  response: AzureBlobResponse,
  accountName: string,
  containerName: string,
  requestedMarker: string | null,
): Promise<{ readonly names: readonly string[]; readonly nextMarker: string | null }> {
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/xml(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new InfrastructureApprovalError("azure-history-content-type-invalid");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
  } catch {
    throw new InfrastructureApprovalError("azure-history-not-utf8");
  }
  if (
    source.length < 1 ||
    /<!\s*(?:DOCTYPE|ENTITY|\[CDATA\[)/i.test(source) ||
    source.includes("\u0000")
  ) {
    throw new InfrastructureApprovalError("azure-history-xml-invalid");
  }
  try {
    const parsed = requireRecord(await parseXML(source, { includeRoot: true }), "history");
    requireExactKeys(parsed, ["EnumerationResults"], "history");
    const root = requireRecord(parsed.EnumerationResults, "history.EnumerationResults");
    requireExactKeys(
      root,
      requestedMarker === null
        ? ["$", "Blobs", "MaxResults", "NextMarker"]
        : ["$", "Blobs", "Marker", "MaxResults", "NextMarker"],
      "history.EnumerationResults",
    );
    const attributes = requireRecord(root.$, "history.EnumerationResults.$");
    requireExactKeys(attributes, ["ServiceEndpoint", "ContainerName"], "history.attributes");
    if (
      attributes.ServiceEndpoint !== `https://${accountName}.blob.core.windows.net/` ||
      attributes.ContainerName !== containerName
    ) {
      throw new InfrastructureApprovalError("azure-history-response-scope-mismatch");
    }
    if (requestedMarker !== null && root.Marker !== requestedMarker) {
      throw new InfrastructureApprovalError("azure-history-marker-mismatch");
    }
    if (root.MaxResults !== String(MAX_HISTORY_LIST_RESULTS)) {
      throw new InfrastructureApprovalError("azure-history-max-results-mismatch");
    }
    const names = parseHistoryNames(root.Blobs);
    if (names.length > MAX_HISTORY_LIST_RESULTS) {
      throw new InfrastructureApprovalError("azure-history-results-over-limit");
    }
    return Object.freeze({
      names: Object.freeze(names),
      nextMarker: historyMarker(root.NextMarker),
    });
  } catch (error) {
    if (error instanceof InfrastructureApprovalError) throw error;
    throw new InfrastructureApprovalError("azure-history-xml-invalid");
  }
}

function parseHistoryNames(value: unknown): string[] {
  if (value === "") return [];
  const blobs = requireRecord(value, "history.Blobs");
  requireExactKeys(blobs, ["Blob"], "history.Blobs");
  const entries = Array.isArray(blobs.Blob) ? blobs.Blob : [blobs.Blob];
  return entries.map((entry, index) => {
    const blob = requireRecord(entry, `history.Blobs.Blob[${index}]`);
    if (!("Name" in blob)) {
      throw new InfrastructureApprovalError("azure-history-name-missing");
    }
    return historyBlobName(blob.Name);
  });
}

function historyBlobName(value: unknown): string {
  let decoded: string;
  if (typeof value === "string") {
    decoded = value;
  } else {
    const encoded = requireRecord(value, "history.Name");
    requireExactKeys(encoded, ["_", "$"], "history.Name");
    const attributes = requireRecord(encoded.$, "history.Name.$");
    requireExactKeys(attributes, ["Encoded"], "history.Name.$");
    if (attributes.Encoded !== "true" || typeof encoded._ !== "string") {
      throw new InfrastructureApprovalError("azure-history-name-encoding-invalid");
    }
    try {
      decoded = decodeURIComponent(encoded._);
    } catch {
      throw new InfrastructureApprovalError("azure-history-name-encoding-invalid");
    }
  }
  if (decoded.length < 1 || decoded.length > 2_048 || containsControlCharacter(decoded)) {
    throw new InfrastructureApprovalError("azure-history-name-invalid");
  }
  return decoded;
}

function historyMarker(value: unknown): string | null {
  if (value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > MAX_HISTORY_MARKER_LENGTH ||
    containsControlCharacter(value)
  ) {
    throw new InfrastructureApprovalError("azure-history-marker-invalid");
  }
  return value;
}

function requireExactInitialState(
  state: AzureBlobResponse,
  canonical: ReturnType<typeof createCanonicalInitialState>,
) {
  const verified = requireCanonicalInitialState(state.bytes);
  const etag = requiredEtag(state.headers);
  if (
    !equalBytes(state.bytes, canonical.bytes) ||
    verified.sha256 !== canonical.sha256 ||
    verified.lineage !== canonical.lineage ||
    state.headers.get("x-ms-meta-switchyard_sha256") !== canonical.sha256
  ) {
    throw new InfrastructureApprovalError("initial-state-roundtrip-mismatch");
  }
  const identity = stateIdentityFromOpenTofuState(state.bytes, etag);
  if (
    identity.backendStateDigest !== canonical.sha256 ||
    identity.lineage !== canonical.lineage ||
    identity.serial !== 0 ||
    !identity.managedResourcesEmpty ||
    identity.managedResourceCount !== 0
  ) {
    throw new InfrastructureApprovalError("initial-state-roundtrip-mismatch");
  }
  return identity;
}

async function withExclusiveBlobLease<T>(input: {
  readonly accountName: string;
  readonly blobName: string;
  readonly containerName: string;
  readonly session: InfrastructureIdentitySession;
  readonly transport: AzureApprovalBlobTransport;
  readonly work: (leaseId: string) => Promise<T>;
}): Promise<T> {
  const leaseId = randomUUID();
  const acquired = await input.transport.request({
    accountName: input.accountName,
    blobName: input.blobName,
    containerName: input.containerName,
    expectedStatuses: [201, 409],
    headers: {
      "x-ms-lease-action": "acquire",
      "x-ms-lease-duration": "-1",
      "x-ms-proposed-lease-id": leaseId,
    },
    maxResponseBytes: 0,
    method: "PUT",
    query: "?comp=lease",
    session: input.session,
  });
  if (acquired.status !== 201 || acquired.headers.get("x-ms-lease-id") !== leaseId) {
    throw new InfrastructureApprovalError("initial-state-lease-unavailable");
  }
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly error: unknown; readonly ok: false };
  let releaseError: unknown;
  try {
    try {
      outcome = { ok: true, value: await input.work(leaseId) };
    } catch (error) {
      outcome = { error, ok: false };
    }
  } finally {
    try {
      await input.transport.request({
        accountName: input.accountName,
        blobName: input.blobName,
        containerName: input.containerName,
        expectedStatuses: [200],
        headers: { "x-ms-lease-action": "release", "x-ms-lease-id": leaseId },
        maxResponseBytes: 0,
        method: "PUT",
        query: "?comp=lease",
        session: input.session,
      });
    } catch (error) {
      releaseError = error;
    }
  }
  if (!outcome.ok) {
    if (releaseError !== undefined) {
      throw new AggregateError(
        [outcome.error, releaseError],
        "initial-state-work-and-lease-release-failed",
      );
    }
    throw outcome.error;
  }
  if (releaseError !== undefined) throw releaseError;
  return outcome.value;
}

function validateStorageConfig(
  config: AzureApprovalStorageConfig,
  policy: InfrastructureApprovalPolicy,
): void {
  validatePolicy(policy);
  validateBackend(config.stateBackend, "azureStorage.stateBackend");
  requireExactBackend(config.stateBackend, policy.backend);
  if (
    config.applyControlContainerName !== "apply-control" ||
    config.receiptContainerName !== "plan-receipts"
  ) {
    throw new InfrastructureApprovalError("azure-storage-container-mismatch");
  }
  storageAccountName(config.receiptStorageAccountName, "azureStorage.receiptStorageAccountName");
  if (config.receiptStorageAccountName === config.stateBackend.storageAccountName) {
    throw new InfrastructureApprovalError("receipt-account-not-separated");
  }
}

function requireAzureSession(
  session: InfrastructureIdentitySession,
  policy: InfrastructureApprovalPolicy,
  allowed: readonly InfrastructureIdentitySession["identity"][],
): void {
  if (!allowed.includes(session.identity)) {
    throw new InfrastructureApprovalError("azure-session-identity-not-allowed");
  }
  verifyIdentitySession(session, session.identity, policy, session.assertionDigest);
}

function requireExactBackend(actual: BackendIdentity, expected: BackendIdentity): void {
  validateBackend(actual, "azure.backend");
  if (
    actual.type !== expected.type ||
    actual.resourceGroupName !== expected.resourceGroupName ||
    actual.storageAccountName !== expected.storageAccountName ||
    actual.containerName !== expected.containerName ||
    actual.key !== expected.key
  ) {
    throw new InfrastructureApprovalError("azure-backend-mismatch");
  }
}

function requireLease(value: ApplyLeaseEvidence): void {
  if (
    value.acquired !== true ||
    value.key !== INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.leaseId)
  ) {
    throw new InfrastructureApprovalError("apply-lease-proof-invalid");
  }
}

function storageAccountName(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z0-9]{3,24}$/.test(value)) {
    throw new InfrastructureApprovalError(`${path}-invalid`);
  }
  return value;
}

function storageContainerName(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(value)) {
    throw new InfrastructureApprovalError(`${path}-invalid`);
  }
  return value;
}

function blobName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new InfrastructureApprovalError("azure-blob-name-invalid");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length < 1 ||
        segment.length > 128 ||
        segment === "." ||
        segment === ".." ||
        containsControlCharacter(segment),
    )
  ) {
    throw new InfrastructureApprovalError("azure-blob-name-invalid");
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function requiredEtag(headers: Headers): string {
  return stateEtag(headers.get("etag"), "azure.etag");
}

function httpInstant(headers: Headers, name: string): string {
  const raw = headers.get(name);
  if (raw === null || raw.length > 128) {
    throw new InfrastructureApprovalError("azure-last-modified-missing");
  }
  const value = new Date(raw);
  if (!Number.isFinite(value.getTime())) {
    throw new InfrastructureApprovalError("azure-last-modified-invalid");
  }
  return value.toISOString();
}

async function readBoundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]+$/.test(declared) ||
      !Number.isSafeInteger(Number(declared)) ||
      Number(declared) > maximum)
  ) {
    await response.body?.cancel();
    throw new InfrastructureApprovalError("azure-storage-response-too-large");
  }
  if (maximum === 0) {
    await response.body?.cancel();
    return new Uint8Array();
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new InfrastructureApprovalError("azure-storage-response-too-large");
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (declared !== null && Number(declared) !== result.byteLength) {
    throw new InfrastructureApprovalError("azure-storage-response-truncated");
  }
  return result;
}

function intentBlob(planDigest: string): string {
  return `intents/${sha256(planDigest, "intent.planDigest")}.json`;
}

function intentBytes(receipt: ApplyIntentReceipt): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(receipt)}\n`);
  if (bytes.byteLength > MAX_CONTROL_BYTES) {
    throw new InfrastructureApprovalError("intent-receipt-too-large");
  }
  return bytes;
}

function parseIntent(bytes: Uint8Array): ApplyIntentReceipt {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InfrastructureApprovalError("intent-receipt-not-utf8");
  }
  const value = parseStrictJson(source, { maxBytes: MAX_CONTROL_BYTES, maxDepth: 16 });
  const receipt = requireRecord(value, "intent") as unknown as ApplyIntentReceipt;
  validateIntentReceipt(receipt);
  return Object.freeze(receipt);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
