import { exceedsUtf8ByteLimit } from "@switchyard/core";

import { MAX_ALLOCATION_REQUEST_BYTES, parseAllocationRequestBody } from "./proof.js";
import {
  ALLOCATION_RETRY_AFTER_SECONDS,
  AllocationServiceError,
  type PortableAllocationService,
} from "./service.js";

const MAX_BEARER_HEADER_BYTES = 24 * 1024;
const MAX_GITHUB_PROOF_HEADER_BYTES = 24 * 1024;
const MAX_PRINCIPAL_HEADER_BYTES = 16 * 1024;

export interface AllocationHttpRequest {
  readonly body: Uint8Array | string | null;
  readonly headers: readonly (readonly [string, string])[];
  readonly method: string;
  readonly url: string;
}

export interface AllocationHttpResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

export interface AllocationHttpService {
  allocate(input: unknown): ReturnType<PortableAllocationService["allocate"]>;
}

/** Strict portable HTTP boundary. A runtime adapter may translate its native request only. */
export function createAllocationHttpHandler(service: AllocationHttpService) {
  return async (request: AllocationHttpRequest): Promise<AllocationHttpResponse> => {
    if (request.method !== "POST") {
      return errorResponse(405, "method-not-allowed", { Allow: "POST" });
    }

    let url: URL;
    try {
      url = new URL(request.url, "https://switchyard.invalid");
    } catch {
      return errorResponse(400, "invalid-request");
    }
    if (url.pathname !== "/api/v1/allocations" || url.search !== "" || url.hash !== "") {
      return errorResponse(400, "invalid-request");
    }

    const headers = collectHeaders(request.headers);
    if (headers === null) return errorResponse(400, "invalid-request");
    const contentType = singleton(headers, "content-type");
    if (contentType.duplicate) return errorResponse(400, "invalid-request");
    if (contentType.value !== "application/json") {
      return errorResponse(415, "unsupported-media-type");
    }

    const body = decodeBody(request.body);
    if (body.outcome === "too-large") return errorResponse(413, "request-too-large");
    if (body.outcome === "invalid") return errorResponse(400, "invalid-request");
    try {
      parseAllocationRequestBody(body.text);
    } catch {
      return errorResponse(400, "invalid-request");
    }

    const authorisation = singleton(headers, "authorization");
    const principal = singleton(headers, "x-ms-client-principal");
    if (
      authorisation.duplicate ||
      principal.duplicate ||
      authorisation.value === undefined ||
      principal.value === undefined ||
      exceedsUtf8ByteLimit(authorisation.value, MAX_BEARER_HEADER_BYTES) ||
      exceedsUtf8ByteLimit(principal.value, MAX_PRINCIPAL_HEADER_BYTES) ||
      !/^Bearer [\x21-\x7e]+$/.test(authorisation.value)
    ) {
      return errorResponse(401, "authentication-required");
    }

    const githubProof = singleton(headers, "x-switchyard-github-oidc");
    if (
      githubProof.duplicate ||
      githubProof.value === undefined ||
      exceedsUtf8ByteLimit(githubProof.value, MAX_GITHUB_PROOF_HEADER_BYTES) ||
      !/^[\x21-\x7e]+$/.test(githubProof.value)
    ) {
      return githubProof.value === undefined && !githubProof.duplicate
        ? errorResponse(401, "authentication-required")
        : errorResponse(403, "allocation-not-authorised");
    }

    try {
      const result = await service.allocate({
        entraProof: principal.value,
        githubOidcJwt: githubProof.value,
        requestBody: body.text,
      });
      if (result.status === "ready") {
        return jsonResponse(200, {
          runner_label: result.runnerLabel,
          allocation_id: result.allocationId,
        });
      }
      return jsonResponse(
        202,
        { allocation_id: result.allocationId, status: "pending" },
        { "Retry-After": String(ALLOCATION_RETRY_AFTER_SECONDS) },
      );
    } catch (error) {
      if (!(error instanceof AllocationServiceError)) {
        return errorResponse(500, "internal-error");
      }
      switch (error.code) {
        case "allocation-conflict":
          return errorResponse(409, "allocation-conflict");
        case "runner-unavailable":
          return errorResponse(409, "runner-unavailable");
        case "allocation-not-authorised":
          return errorResponse(403, "allocation-not-authorised");
        case "controller-unavailable":
          return errorResponse(503, "controller-unavailable", {
            "Retry-After": String(ALLOCATION_RETRY_AFTER_SECONDS),
          });
        case "internal-error":
          return errorResponse(500, "internal-error");
      }
    }
  };
}

function collectHeaders(
  entries: readonly (readonly [string, string])[],
): Map<string, readonly string[]> | null {
  if (!Array.isArray(entries)) return null;
  const collected = new Map<string, string[]>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [rawName, value] = entry;
    if (
      typeof rawName !== "string" ||
      typeof value !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName)
    ) {
      return null;
    }
    const name = rawName.toLowerCase();
    const values = collected.get(name) ?? [];
    values.push(value);
    collected.set(name, values);
  }
  return collected;
}

function singleton(headers: Map<string, readonly string[]>, name: string) {
  const values = headers.get(name) ?? [];
  return {
    duplicate: values.length > 1,
    value: values.length === 1 ? values[0] : undefined,
  } as const;
}

function decodeBody(
  body: AllocationHttpRequest["body"],
):
  | { readonly outcome: "invalid" }
  | { readonly outcome: "too-large" }
  | { readonly outcome: "valid"; readonly text: string } {
  if (body === null) return { outcome: "invalid" };
  if (typeof body === "string") {
    return exceedsUtf8ByteLimit(body, MAX_ALLOCATION_REQUEST_BYTES)
      ? { outcome: "too-large" }
      : { outcome: "valid", text: body };
  }
  if (!(body instanceof Uint8Array)) return { outcome: "invalid" };
  if (body.byteLength > MAX_ALLOCATION_REQUEST_BYTES) return { outcome: "too-large" };
  try {
    return {
      outcome: "valid",
      text: new TextDecoder("utf-8", { fatal: true }).decode(body),
    };
  } catch {
    return { outcome: "invalid" };
  }
}

function errorResponse(
  status: number,
  code: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): AllocationHttpResponse {
  return jsonResponse(status, { error: code }, extraHeaders);
}

function jsonResponse(
  status: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): AllocationHttpResponse {
  return {
    body: JSON.stringify(value),
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
    status,
  };
}
