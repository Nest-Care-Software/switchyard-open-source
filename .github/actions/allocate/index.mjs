import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_POLL_TIMEOUT_MILLISECONDS = 14 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 8 * 1024;

export class AllocationClientError extends Error {
  constructor(code) {
    super("Switchyard allocation failed");
    this.name = "AllocationClientError";
    this.code = code;
  }
}

export async function requestAllocation(options) {
  const config = validateOptions(options);
  const entraAssertion = await requestGitHubOidc(config, config.entraAssertionAudience);
  const accessToken = await exchangeEntraAssertion(config, entraAssertion);
  const startedAt = requiredMonotonicNow(config);
  let lastObservedAt = startedAt;
  let allocationId;

  while (true) {
    const observedAt = requiredMonotonicNow(config);
    if (observedAt < lastObservedAt) {
      throw new AllocationClientError("controller-unavailable");
    }
    lastObservedAt = observedAt;
    if (observedAt - startedAt >= config.pollTimeoutMilliseconds) {
      throw new AllocationClientError("controller-unavailable");
    }
    const freshAllocationProof = await requestGitHubOidc(config, config.allocationProofAudience);
    const response = await boundedFetch(config, config.allocationApiUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Switchyard-GitHub-OIDC": freshAllocationProof,
      },
      body: config.requestBody,
    });
    const body = await readBoundedJson(response, { requireCanonical: true });
    if (response.status === 200) {
      requireExactKeys(body, ["runner_label", "allocation_id"]);
      const returnedAllocationId = requireIdentifier(body.allocation_id, "allocation-conflict");
      if (allocationId !== undefined && allocationId !== returnedAllocationId) {
        throw new AllocationClientError("allocation-conflict");
      }
      return {
        allocation_id: returnedAllocationId,
        runner_label: requireRunnerLabel(body.runner_label),
      };
    }
    if (response.status === 202) {
      requireExactKeys(body, ["allocation_id", "status"]);
      if (body.status !== "pending") throw new AllocationClientError("internal-error");
      const returnedAllocationId = requireIdentifier(body.allocation_id, "allocation-conflict");
      if (allocationId !== undefined && allocationId !== returnedAllocationId) {
        throw new AllocationClientError("allocation-conflict");
      }
      allocationId = returnedAllocationId;
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter === null || !/^[1-9]\d?$/.test(retryAfter)) {
        throw new AllocationClientError("internal-error");
      }
      const retryAfterSeconds = Number(retryAfter);
      if (retryAfterSeconds > 60) throw new AllocationClientError("internal-error");
      await config.wait(retryAfterSeconds * 1_000);
      continue;
    }
    const code = readRedactedError(body);
    if (
      response.status === 409 ||
      response.status === 403 ||
      response.status === 401 ||
      response.status === 400 ||
      response.status === 413 ||
      response.status === 415 ||
      response.status === 503 ||
      response.status === 500
    ) {
      throw new AllocationClientError(code);
    }
    throw new AllocationClientError("internal-error");
  }
}

async function requestGitHubOidc(config, audience) {
  const url = new URL(config.oidcRequestUrl);
  url.searchParams.set("audience", audience);
  const response = await boundedFetch(config, url.href, {
    method: "GET",
    redirect: "error",
    headers: { Authorization: `Bearer ${config.oidcRequestToken}` },
  });
  if (response.status !== 200) throw new AllocationClientError("controller-unavailable");
  const body = await readBoundedJson(response);
  requireExactKeys(body, ["value"]);
  return requireToken(body.value);
}

async function exchangeEntraAssertion(config, assertion) {
  const body = new URLSearchParams({
    client_assertion: assertion,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_id: config.entraClientId,
    grant_type: "client_credentials",
    scope: `${config.allocationApiAudience}/.default`,
  });
  const response = await boundedFetch(
    config,
    `https://login.microsoftonline.com/${encodeURIComponent(config.entraTenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (response.status !== 200) throw new AllocationClientError("authentication-required");
  const value = await readBoundedJson(response);
  if (
    value.token_type !== "Bearer" ||
    typeof value.expires_in !== "number" ||
    !Number.isSafeInteger(value.expires_in) ||
    value.expires_in * 1_000 < config.pollTimeoutMilliseconds + config.requestTimeoutMilliseconds
  ) {
    throw new AllocationClientError("authentication-required");
  }
  return requireToken(value.access_token);
}

async function boundedFetch(config, url, init) {
  const controller = new AbortController();
  let timer;
  const request = Promise.resolve().then(() =>
    config.fetch(url, { ...init, signal: controller.signal }),
  );
  request.catch(() => undefined);
  try {
    return await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AllocationClientError("controller-unavailable"));
        }, config.requestTimeoutMilliseconds);
      }),
    ]);
  } catch (error) {
    if (error instanceof AllocationClientError) throw error;
    throw new AllocationClientError("controller-unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readBoundedJson(response, options = {}) {
  const text = await readBoundedText(response);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AllocationClientError("internal-error");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AllocationClientError("internal-error");
  }
  if (options.requireCanonical === true && JSON.stringify(value) !== text) {
    throw new AllocationClientError("internal-error");
  }
  return value;
}

async function readBoundedText(response) {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AllocationClientError("internal-error");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AllocationClientError("internal-error");
  }
}

function validateOptions(options) {
  if (typeof options !== "object" || options === null) {
    throw new AllocationClientError("invalid-request");
  }
  const requiredStrings = [
    "allocationApiAudience",
    "allocationApiUrl",
    "allocationProofAudience",
    "entraAssertionAudience",
    "entraClientId",
    "entraTenantId",
    "oidcRequestToken",
    "oidcRequestUrl",
    "requestBody",
  ];
  for (const key of requiredStrings) {
    if (typeof options[key] !== "string" || options[key].length < 1) {
      throw new AllocationClientError("invalid-request");
    }
  }
  const allocationApiUrl = requireHttpsUrl(options.allocationApiUrl, {
    allowQuery: false,
    expectedPath: "/api/v1/allocations",
  });
  const oidcRequestUrl = requireHttpsUrl(options.oidcRequestUrl, { allowQuery: true });
  const requestTimeoutMilliseconds =
    options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS;
  const pollTimeoutMilliseconds =
    options.pollTimeoutMilliseconds ?? DEFAULT_POLL_TIMEOUT_MILLISECONDS;
  const configuredFetch = options.fetch ?? fetch;
  const monotonicNowMilliseconds = options.monotonicNowMilliseconds ?? (() => performance.now());
  const configuredWait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (
    !Number.isSafeInteger(requestTimeoutMilliseconds) ||
    requestTimeoutMilliseconds < 1 ||
    !Number.isSafeInteger(pollTimeoutMilliseconds) ||
    pollTimeoutMilliseconds < 1 ||
    typeof configuredFetch !== "function" ||
    typeof monotonicNowMilliseconds !== "function" ||
    typeof configuredWait !== "function"
  ) {
    throw new AllocationClientError("invalid-request");
  }
  return {
    ...options,
    allocationApiUrl,
    fetch: configuredFetch,
    monotonicNowMilliseconds,
    oidcRequestUrl,
    pollTimeoutMilliseconds,
    requestTimeoutMilliseconds,
    wait: configuredWait,
  };
}

function requireHttpsUrl(value, options) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AllocationClientError("invalid-request");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (!options.allowQuery && url.search !== "") ||
    (options.expectedPath !== undefined && url.pathname !== options.expectedPath)
  ) {
    throw new AllocationClientError("invalid-request");
  }
  return url.href;
}

function requiredMonotonicNow(config) {
  const value = config.monotonicNowMilliseconds();
  if (!Number.isFinite(value) || value < 0) {
    throw new AllocationClientError("controller-unavailable");
  }
  return value;
}

function requireExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AllocationClientError("internal-error");
  }
}

function requireToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 24 * 1024 ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new AllocationClientError("authentication-required");
  }
  return value;
}

function requireIdentifier(value, code) {
  if (typeof value !== "string" || !/^sy1-[0-9a-f]{64}$/.test(value)) {
    throw new AllocationClientError(code);
  }
  return value;
}

function requireRunnerLabel(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new AllocationClientError("internal-error");
  }
  return value;
}

function readRedactedError(body) {
  try {
    requireExactKeys(body, ["error"]);
  } catch {
    return "internal-error";
  }
  return typeof body.error === "string" && /^[a-z][a-z-]{0,63}$/.test(body.error)
    ? body.error
    : "internal-error";
}

async function main(environment) {
  const result = await requestAllocation({
    allocationApiAudience: requiredEnvironment(environment, "SWITCHYARD_API_AUDIENCE"),
    allocationApiUrl: requiredEnvironment(environment, "SWITCHYARD_API_URL"),
    allocationProofAudience: requiredEnvironment(
      environment,
      "SWITCHYARD_ALLOCATION_PROOF_AUDIENCE",
    ),
    entraAssertionAudience: requiredEnvironment(environment, "SWITCHYARD_ENTRA_ASSERTION_AUDIENCE"),
    entraClientId: requiredEnvironment(environment, "SWITCHYARD_ENTRA_CLIENT_ID"),
    entraTenantId: requiredEnvironment(environment, "SWITCHYARD_ENTRA_TENANT_ID"),
    oidcRequestToken: requiredEnvironment(environment, "ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
    oidcRequestUrl: requiredEnvironment(environment, "ACTIONS_ID_TOKEN_REQUEST_URL"),
    requestBody: JSON.stringify({
      identity: {
        repository_id: requiredEnvironment(environment, "SWITCHYARD_REPOSITORY_ID"),
        run_id: requiredEnvironment(environment, "SWITCHYARD_RUN_ID"),
        run_attempt: Number(requiredEnvironment(environment, "SWITCHYARD_RUN_ATTEMPT")),
        allocator_check_run_id: requiredEnvironment(
          environment,
          "SWITCHYARD_ALLOCATOR_CHECK_RUN_ID",
        ),
      },
      profile: requiredEnvironment(environment, "SWITCHYARD_PROFILE"),
      backupChoice: requiredEnvironment(environment, "SWITCHYARD_BACKUP_CHOICE"),
    }),
  });
  const output = requiredEnvironment(environment, "GITHUB_OUTPUT");
  appendFileSync(
    output,
    `runner_label=${result.runner_label}\nallocation_id=${result.allocation_id}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length < 1) {
    throw new AllocationClientError("invalid-configuration");
  }
  return value;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.env).catch((error) => {
    const code = error instanceof AllocationClientError ? error.code : "internal-error";
    process.stderr.write(`Switchyard allocation failed (${code}).\n`);
    process.exitCode = 1;
  });
}
