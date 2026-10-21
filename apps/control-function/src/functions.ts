import type { HttpRequest, HttpResponseInit, InvocationContext, Timer } from "@azure/functions";
import { MAX_ALLOCATION_REQUEST_BYTES, type AllocationHttpResponse } from "@switchyard/controller";
import type { AzureProvisioningQueueMessage, AzureWorkerResult } from "@switchyard/azure-worker";
import type { ReconcilerCycleResult } from "@switchyard/reconciler";

export interface ControlFunctionRuntime {
  readonly allocate: (request: {
    readonly body: Uint8Array | null;
    readonly headers: readonly (readonly [string, string])[];
    readonly method: string;
    readonly url: string;
  }) => Promise<AllocationHttpResponse>;
  readonly provision: (message: unknown) => Promise<AzureWorkerResult>;
  readonly poison: (message: unknown) => Promise<{ readonly allocationId: string | null }>;
  readonly reconcile: () => Promise<ReconcilerCycleResult>;
}

export async function allocationHttp(
  request: HttpRequest,
  context: InvocationContext,
  runtime: ControlFunctionRuntime,
): Promise<HttpResponseInit> {
  let body: Uint8Array | null;
  try {
    body = await readBoundedBody(request, MAX_ALLOCATION_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      context.warn(JSON.stringify(lifecycleLog("allocation-http", "request-too-large")));
      return jsonError(413, "request-too-large");
    }
    context.warn(JSON.stringify(lifecycleLog("allocation-http", "request-invalid")));
    return jsonError(400, "invalid-request");
  }

  const response = await runtime.allocate({
    body,
    headers: [...request.headers.entries()],
    method: request.method,
    url: request.url,
  });
  context.info(JSON.stringify(lifecycleLog("allocation-http", `status-${response.status}`)));
  return response;
}

export async function provisionAllocation(
  message: unknown,
  context: InvocationContext,
  runtime: ControlFunctionRuntime,
): Promise<void> {
  const result = await runtime.provision(parseQueueTriggerValue(message));
  context.info(
    JSON.stringify(
      lifecycleLog("azure-provision", result.outcome, {
        allocation_id: result.allocationId,
        result_code:
          result.outcome === "incident"
            ? result.code
            : result.outcome === "progress"
              ? result.stage
              : result.outcome === "unavailable"
                ? result.classification
                : result.outcome,
      }),
    ),
  );
  if (result.outcome === "incident") {
    // The worker already raised the incident. Reconciliation owns continued
    // cleanup, so poison retries must not block or duplicate that repair.
    return;
  }
}

export async function provisioningPoison(
  message: unknown,
  context: InvocationContext,
  runtime: ControlFunctionRuntime,
): Promise<void> {
  const result = await runtime.poison(message);
  context.error(
    JSON.stringify(
      lifecycleLog("azure-provision-poison", "message-poisoned", {
        ...(result.allocationId === null ? {} : { allocation_id: result.allocationId }),
      }),
    ),
  );
}

export async function reconcileAllocations(
  _timer: Timer,
  context: InvocationContext,
  runtime: ControlFunctionRuntime,
): Promise<void> {
  const result = await runtime.reconcile();
  context.info(
    JSON.stringify(
      lifecycleLog("reconcile", result.heartbeatRecorded ? "complete" : "incomplete", {
        lifecycle_failures: result.lifecycleFailures,
        processed_allocations: result.processedAllocations,
        visibility_failures: result.visibilityFailures,
      }),
    ),
  );
  if (!result.heartbeatRecorded) {
    throw new Error("Reconciliation did not record a successful safety heartbeat");
  }
}

function parseQueueTriggerValue(value: unknown): AzureProvisioningQueueMessage {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 4_096) throw new TypeError("queue message too large");
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
    record.provider !== "azure" ||
    record.ordinal !== 1 ||
    typeof record.allocation_id !== "string"
  ) {
    throw new TypeError("queue message is invalid");
  }
  return {
    allocation_id: record.allocation_id,
    ordinal: 1,
    provider: "azure",
  };
}

async function readBoundedBody(request: HttpRequest, limit: number): Promise<Uint8Array | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) throw new TypeError("content length invalid");
    if (Number(contentLength) > limit) throw new RequestBodyTooLargeError();
  }
  const body = request.body;
  if (body === null) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function lifecycleLog(
  stage_code: string,
  result_code: string,
  fields: Readonly<Record<string, number | string>> = {},
) {
  return {
    event: "switchyard-lifecycle",
    stage_code,
    result_code,
    ...fields,
  };
}

function jsonError(status: number, error: string): HttpResponseInit {
  return {
    body: JSON.stringify({ error }),
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
    status,
  };
}

class RequestBodyTooLargeError extends Error {}
