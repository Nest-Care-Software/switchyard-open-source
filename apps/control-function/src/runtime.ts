import type { TokenCredential } from "@azure/core-auth";
import { QueueClient } from "@azure/storage-queue";
import type { AllocationHttpResponse } from "@switchyard/controller";
import type {
  AzureGenerationOneWorker,
  AzureProvisioningQueueMessage,
  AzureWorkerResult,
} from "@switchyard/azure-worker";
import type { ReconcilerCycleResult } from "@switchyard/reconciler";

import type { ControlFunctionRuntime } from "./functions.js";

export interface SafetyRuntime {
  poison(message: unknown): Promise<{ readonly allocationId: string | null }>;
  provision(message: unknown): Promise<AzureWorkerResult>;
  reconcile(): Promise<ReconcilerCycleResult>;
}

export interface AdmissionRuntime {
  allocate(request: {
    readonly body: Uint8Array | null;
    readonly headers: readonly (readonly [string, string])[];
    readonly method: string;
    readonly url: string;
  }): Promise<AllocationHttpResponse>;
}

export interface ProvisioningQueuePort {
  dispatch(message: AzureProvisioningQueueMessage, delaySeconds: number): Promise<void>;
}

/** Admission can fail independently; safety construction is a process prerequisite. */
export class SplitControlFunctionRuntime implements ControlFunctionRuntime {
  readonly #admission: () => Promise<AdmissionRuntime>;
  readonly #safety: SafetyRuntime;
  #admissionPromise: Promise<AdmissionRuntime> | null = null;

  constructor(options: {
    readonly admission: () => Promise<AdmissionRuntime>;
    readonly safety: SafetyRuntime;
  }) {
    this.#admission = options.admission;
    this.#safety = options.safety;
  }

  async allocate(
    request: Parameters<AdmissionRuntime["allocate"]>[0],
  ): Promise<AllocationHttpResponse> {
    try {
      this.#admissionPromise ??= this.#admission();
      return await (await this.#admissionPromise).allocate(request);
    } catch {
      this.#admissionPromise = null;
      return unavailableResponse();
    }
  }

  poison(message: unknown) {
    return this.#safety.poison(message);
  }

  provision(message: unknown) {
    return this.#safety.provision(message);
  }

  reconcile() {
    return this.#safety.reconcile();
  }
}

export class QueueDrivenSafetyRuntime implements SafetyRuntime {
  readonly #queue: ProvisioningQueuePort;
  readonly #reconcile: () => Promise<ReconcilerCycleResult>;
  readonly #worker: AzureGenerationOneWorker;

  constructor(options: {
    readonly queue: ProvisioningQueuePort;
    readonly reconcile: () => Promise<ReconcilerCycleResult>;
    readonly worker: AzureGenerationOneWorker;
  }) {
    this.#queue = options.queue;
    this.#reconcile = options.reconcile;
    this.#worker = options.worker;
  }

  async provision(message: unknown): Promise<AzureWorkerResult> {
    const canonical = parseAzureProvisioningMessage(message);
    const result = await this.#worker.reconcile(canonical);
    if (result.outcome === "progress") {
      // A lost response can duplicate the raw message. Ledger revisions and
      // provider leases make duplicate delivery harmless.
      await this.#queue.dispatch(canonical, 5);
    }
    return result;
  }

  async poison(message: unknown): Promise<{ readonly allocationId: string | null }> {
    try {
      return { allocationId: parseAzureProvisioningMessage(message).allocation_id };
    } catch {
      return { allocationId: null };
    }
  }

  reconcile() {
    return this.#reconcile();
  }
}

export class ManagedIdentityProvisioningQueue implements ProvisioningQueuePort {
  readonly #client: QueueClient;

  constructor(options: {
    readonly accountName: string;
    readonly credential: TokenCredential;
    readonly queueName: string;
  }) {
    if (!/^[a-z0-9]{3,24}$/.test(options.accountName)) {
      throw new TypeError("storage account name is invalid");
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(options.queueName)) {
      throw new TypeError("queue name is invalid");
    }
    this.#client = new QueueClient(
      `https://${options.accountName}.queue.core.windows.net/${options.queueName}`,
      options.credential,
      { retryOptions: { maxTries: 1, tryTimeoutInMs: 5_000 } },
    );
  }

  async dispatch(message: AzureProvisioningQueueMessage, delaySeconds: number): Promise<void> {
    const canonical = parseAzureProvisioningMessage(message);
    if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 30) {
      throw new TypeError("queue delay is invalid");
    }
    await this.#client.sendMessage(JSON.stringify(canonical), {
      visibilityTimeout: delaySeconds,
    });
  }
}

export function parseAzureProvisioningMessage(value: unknown): AzureProvisioningQueueMessage {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > 4_096)
      throw new TypeError("queue message too large");
    parsed = JSON.parse(value);
  } else if (value instanceof Uint8Array) {
    if (value.byteLength > 4_096) throw new TypeError("queue message too large");
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("queue message is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== 3 ||
    typeof record.allocation_id !== "string" ||
    !/^sy1-[a-f0-9]{64}$/.test(record.allocation_id) ||
    record.ordinal !== 1 ||
    record.provider !== "azure"
  ) {
    throw new TypeError("queue message is invalid");
  }
  return { allocation_id: record.allocation_id, ordinal: 1, provider: "azure" };
}

function unavailableResponse(): AllocationHttpResponse {
  return {
    body: JSON.stringify({ error: "controller-unavailable" }),
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": "5",
      "X-Content-Type-Options": "nosniff",
    },
    status: 503,
  };
}
