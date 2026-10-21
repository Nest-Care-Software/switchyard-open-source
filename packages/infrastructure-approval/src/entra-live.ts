import {
  ContractValidationError,
  parseStrictJson,
  requireExactKeys,
  requireRecord,
} from "@switchyard/core";

import {
  azureUuid,
  exactString,
  type GitHubOidcEntraExchangePort,
  type InfrastructureIdentitySession,
  InfrastructureApprovalError,
  sha256Bytes,
} from "./contracts.js";

export const AZURE_MANAGEMENT_SCOPE = "https://management.azure.com//.default" as const;
export const AZURE_MANAGEMENT_AUDIENCE = "https://management.azure.com/" as const;
export const AZURE_STORAGE_SCOPE = "https://storage.azure.com/.default" as const;
export const AZURE_STORAGE_AUDIENCE = "https://storage.azure.com" as const;
export const ENTRA_CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" as const;

const ENTRA_ORIGIN = "https://login.microsoftonline.com";
const TOKEN_RESPONSE_LIMIT = 32 * 1024;
const NETWORK_TIMEOUT_MS = 5_000;
const MINIMUM_TOKEN_LIFETIME_SECONDS = 60;
const MAXIMUM_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const MAXIMUM_SESSION_CREDENTIAL_LIFETIME_SECONDS = 45 * 60;
const MAX_TOKEN_BYTES = 16 * 1024;

type FetchLike = (input: string | URL, init: RequestInit) => Promise<Response>;

interface AcquiredToken {
  readonly expiresOnTimestamp: number;
  readonly token: string;
}

/** Exact client-credentials exchange. It has no ambient credential or fallback path. */
export class LiveGitHubOidcEntraExchange implements GitHubOidcEntraExchangePort {
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(options: { readonly fetch?: FetchLike; readonly now?: () => number } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async exchangeExactToken(
    input: Parameters<GitHubOidcEntraExchangePort["exchangeExactToken"]>[0],
  ) {
    if (input.allowAmbientCredentials !== false) invalid("entra-ambient-credential-requested");
    const tenantId = azureUuid(input.tenantId, "entra.tenantId");
    const clientId = azureUuid(input.clientId, "entra.clientId");
    const principalId = azureUuid(input.principalId, "entra.principalId");
    exactString(input.audience, "entra.githubAudience", 256);
    exactString(input.jobWorkflowRef, "entra.jobWorkflowRef", 512);
    exactString(input.subject, "entra.subject", 512);
    if (
      !(input.rawToken instanceof Uint8Array) ||
      input.rawToken.byteLength < 32 ||
      input.rawToken.byteLength > MAX_TOKEN_BYTES
    ) {
      invalid("entra-client-assertion-size-invalid");
    }
    const assertionDigest = sha256Bytes(input.rawToken);
    const management = await this.#exchange({
      clientId,
      rawAssertion: input.rawToken,
      scope: AZURE_MANAGEMENT_SCOPE,
      tenantId,
    });
    requireUnchanged(input.rawToken, assertionDigest);
    const storage = await this.#exchange({
      clientId,
      rawAssertion: input.rawToken,
      scope: AZURE_STORAGE_SCOPE,
      tenantId,
    });
    requireUnchanged(input.rawToken, assertionDigest);

    const tokens = new Map<string, AcquiredToken>([
      [AZURE_MANAGEMENT_SCOPE, management],
      [AZURE_STORAGE_SCOPE, storage],
    ]);
    const sessionCredentialExpiry =
      this.#now() + MAXIMUM_SESSION_CREDENTIAL_LIFETIME_SECONDS * 1_000;
    const credential = Object.freeze({
      getToken: async (scope: string) => {
        const token = tokens.get(scope);
        const expiresOnTimestamp = Math.min(
          token?.expiresOnTimestamp ?? 0,
          sessionCredentialExpiry,
        );
        if (token === undefined || expiresOnTimestamp <= this.#now() + 30_000) return null;
        return Object.freeze({
          expiresOnTimestamp,
          token: token.token,
        });
      },
    });
    const session: InfrastructureIdentitySession = Object.freeze({
      ambientCredentialsUsed: false,
      assertionDigest,
      audience: input.audience,
      authentication: "github-oidc-client-assertion",
      clientId,
      credential,
      identity: input.identity,
      jobWorkflowRef: input.jobWorkflowRef,
      principalId,
      subject: input.subject,
      subscriptionId: azureUuid(input.subscriptionId, "entra.subscriptionId"),
      tenantId,
    });
    return session;
  }

  async #exchange(input: {
    readonly clientId: string;
    readonly rawAssertion: Uint8Array;
    readonly scope: string;
    readonly tenantId: string;
  }): Promise<AcquiredToken> {
    let assertion: string;
    try {
      assertion = new TextDecoder("ascii", { fatal: true }).decode(input.rawAssertion);
    } catch {
      return invalid("entra-client-assertion-not-ascii");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(assertion)) invalid("entra-client-assertion-malformed");
    const form = new URLSearchParams();
    form.set("client_id", input.clientId);
    form.set("scope", input.scope);
    form.set("client_assertion_type", ENTRA_CLIENT_ASSERTION_TYPE);
    form.set("client_assertion", assertion);
    form.set("grant_type", "client_credentials");
    const requestBytes = Buffer.from(form.toString(), "utf8");
    form.set("client_assertion", "");
    let response: Response;
    try {
      response = await this.#fetch(`${ENTRA_ORIGIN}/${input.tenantId}/oauth2/v2.0/token`, {
        body: requestBytes,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
    } catch {
      return invalid("entra-token-endpoint-unavailable");
    } finally {
      requestBytes.fill(0);
      assertion = "";
    }
    const bytes = await readBounded(response, TOKEN_RESPONSE_LIMIT);
    if (response.status !== 200) {
      bytes.fill(0);
      return invalid(`entra-token-status-${response.status}`);
    }
    let body: Record<string, unknown>;
    try {
      body = strictJsonRecord(bytes, "entraTokenResponse", TOKEN_RESPONSE_LIMIT);
      requireExactKeys(
        body,
        ["token_type", "expires_in", "ext_expires_in", "access_token"],
        "entraTokenResponse",
      );
    } catch (error) {
      if (error instanceof ContractValidationError) invalid("entra-token-response-invalid");
      throw error;
    } finally {
      bytes.fill(0);
    }
    if (body.token_type !== "Bearer") invalid("entra-token-type-invalid");
    const expiresIn = boundedLifetime(body.expires_in, "expires_in");
    const extended = boundedLifetime(body.ext_expires_in, "ext_expires_in");
    if (extended < expiresIn) invalid("entra-token-extended-expiry-invalid");
    const token = opaqueBearerToken(body.access_token);
    const responseExpiry = this.#now() + expiresIn * 1_000;
    return Object.freeze({ expiresOnTimestamp: responseExpiry, token });
  }
}

function strictJsonRecord(
  bytes: Uint8Array,
  path: string,
  maxBytes: number,
): Record<string, unknown> {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid(`${path}-not-utf8`);
  }
  return requireRecord(parseStrictJson(source, { maxBytes, maxDepth: 5 }), path);
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]+$/.test(declared) ||
      !Number.isSafeInteger(Number(declared)) ||
      Number(declared) > maximum)
  ) {
    await response.body?.cancel();
    return invalid("entra-token-response-oversize");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        return invalid("entra-token-response-oversize");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof InfrastructureApprovalError) throw error;
    return invalid("entra-token-response-read-failed");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (declared !== null && Number(declared) !== bytes.byteLength) {
    bytes.fill(0);
    return invalid("entra-token-response-truncated");
  }
  return bytes;
}

function boundedLifetime(value: unknown, field: string): number {
  const lifetime =
    typeof value === "string" && /^[1-9][0-9]{0,4}$/.test(value) ? Number(value) : value;
  if (
    !Number.isSafeInteger(lifetime) ||
    (lifetime as number) < MINIMUM_TOKEN_LIFETIME_SECONDS ||
    (lifetime as number) > MAXIMUM_TOKEN_LIFETIME_SECONDS
  ) {
    invalid(`entra-token-${field}-invalid`);
  }
  return lifetime as number;
}

/** Azure Management and Storage own these bearer tokens; this client never decodes them. */
function opaqueBearerToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > MAX_TOKEN_BYTES ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(value)
  ) {
    invalid("entra-access-token-invalid");
  }
  return value;
}

function requireUnchanged(bytes: Uint8Array, digest: string): void {
  if (sha256Bytes(bytes) !== digest) invalid("oidc-token-mutated");
}

function invalid(code: string): never {
  throw new InfrastructureApprovalError(code);
}
