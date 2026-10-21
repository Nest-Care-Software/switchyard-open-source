export interface AccessJwtConfiguration {
  readonly audience: string;
  readonly issuer: string;
}

export interface AccessJwtDependencies {
  readonly cache?: AccessJwksCache;
  readonly fetch?: typeof fetch;
  readonly now?: Date;
  readonly subtle?: SubtleCrypto;
}

interface AccessJwtHeader {
  readonly alg: "RS256";
  readonly kid: string;
  readonly typ: "JWT";
}

interface AccessJwtClaims {
  readonly aud: readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly iss: string;
  readonly nbf?: number;
  readonly type: "app";
}

interface JwksDocument {
  readonly keys: readonly AccessJsonWebKey[];
}

interface CachedJwks {
  readonly expiresAtMilliseconds: number;
  readonly keys: readonly AccessJsonWebKey[];
}

interface AccessJsonWebKey extends JsonWebKey {
  readonly kid?: string;
}

const CLOCK_SKEW_SECONDS = 30;
const JWKS_CACHE_MILLISECONDS = 5 * 60 * 1_000;
const MAXIMUM_TOKEN_LENGTH = 16 * 1_024;

export class AccessJwtError extends Error {
  constructor() {
    super("Cloudflare Access authentication failed");
    this.name = "AccessJwtError";
  }
}

export class AccessJwksCache {
  readonly #entries = new Map<string, CachedJwks>();

  read(issuer: string, nowMilliseconds: number): readonly AccessJsonWebKey[] | undefined {
    const cached = this.#entries.get(issuer);
    if (cached === undefined || cached.expiresAtMilliseconds <= nowMilliseconds) {
      this.#entries.delete(issuer);
      return undefined;
    }
    return cached.keys;
  }

  write(issuer: string, keys: readonly AccessJsonWebKey[], nowMilliseconds: number): void {
    this.#entries.set(issuer, {
      keys,
      expiresAtMilliseconds: nowMilliseconds + JWKS_CACHE_MILLISECONDS,
    });
  }
}

const defaultJwksCache = new AccessJwksCache();

export async function validateAccessRequest(
  request: Request,
  configuration: AccessJwtConfiguration,
  dependencies: AccessJwtDependencies = {},
): Promise<void> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (assertion === null) {
    throw new AccessJwtError();
  }
  await validateAccessJwt(assertion, configuration, dependencies);
}

export async function validateAccessJwt(
  token: string,
  configuration: AccessJwtConfiguration,
  dependencies: AccessJwtDependencies = {},
): Promise<void> {
  try {
    const issuer = parseIssuer(configuration.issuer);
    const audience = requireNonEmpty(configuration.audience);
    const now = dependencies.now ?? new Date();
    const nowMilliseconds = now.getTime();
    if (!Number.isFinite(nowMilliseconds)) {
      throw new Error("invalid clock");
    }
    if (token.length === 0 || token.length > MAXIMUM_TOKEN_LENGTH) {
      throw new Error("invalid token size");
    }

    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
      throw new Error("invalid compact JWT");
    }
    const [encodedHeader, encodedClaims, encodedSignature] = segments as [string, string, string];
    const header = parseHeader(decodeJsonSegment(encodedHeader));
    const claims = parseClaims(decodeJsonSegment(encodedClaims));
    validateClaims(claims, issuer, audience, Math.floor(nowMilliseconds / 1_000));

    const cache = dependencies.cache ?? defaultJwksCache;
    const fetchImplementation = dependencies.fetch ?? fetch;
    const keys = await loadJwks(issuer, cache, fetchImplementation, nowMilliseconds);
    const signingKey = keys.find(
      (key) =>
        key.kid === header.kid &&
        key.kty === "RSA" &&
        (key.alg === undefined || key.alg === "RS256") &&
        (key.use === undefined || key.use === "sig"),
    );
    if (signingKey === undefined) {
      throw new Error("unknown signing key");
    }

    const subtle = dependencies.subtle ?? crypto.subtle;
    const publicKey = await subtle.importKey(
      "jwk",
      signingKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    );
    if (!verified) {
      throw new Error("invalid signature");
    }
  } catch {
    throw new AccessJwtError();
  }
}

async function loadJwks(
  issuer: string,
  cache: AccessJwksCache,
  fetchImplementation: typeof fetch,
  nowMilliseconds: number,
): Promise<readonly AccessJsonWebKey[]> {
  const cached = cache.read(issuer, nowMilliseconds);
  if (cached !== undefined) {
    return cached;
  }

  const response = await fetchImplementation(`${issuer}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error("JWKS unavailable");
  }
  const document = parseJwks(await response.json());
  cache.write(issuer, document.keys, nowMilliseconds);
  return document.keys;
}

function parseHeader(value: unknown): AccessJwtHeader {
  const record = requireRecord(value);
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !keys.includes("alg") ||
    !keys.includes("kid") ||
    !keys.includes("typ") ||
    record.alg !== "RS256" ||
    record.typ !== "JWT" ||
    typeof record.kid !== "string" ||
    record.kid.length === 0 ||
    record.kid.length > 256
  ) {
    throw new Error("invalid JWT header");
  }
  return { alg: "RS256", typ: "JWT", kid: record.kid };
}

function parseClaims(value: unknown): AccessJwtClaims {
  const record = requireRecord(value);
  if (
    !Array.isArray(record.aud) ||
    record.aud.length === 0 ||
    !record.aud.every((entry) => typeof entry === "string" && entry.length > 0) ||
    typeof record.iss !== "string" ||
    record.type !== "app" ||
    !Number.isSafeInteger(record.exp) ||
    !Number.isSafeInteger(record.iat) ||
    (record.nbf !== undefined && !Number.isSafeInteger(record.nbf))
  ) {
    throw new Error("invalid JWT claims");
  }

  return {
    aud: record.aud as string[],
    iss: record.iss,
    type: "app",
    exp: record.exp as number,
    iat: record.iat as number,
    ...(record.nbf === undefined ? {} : { nbf: record.nbf as number }),
  };
}

function validateClaims(
  claims: AccessJwtClaims,
  issuer: string,
  audience: string,
  nowSeconds: number,
): void {
  if (
    claims.iss !== issuer ||
    !claims.aud.includes(audience) ||
    claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS ||
    claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    (claims.nbf !== undefined && claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS)
  ) {
    throw new Error("JWT claims rejected");
  }
}

function parseJwks(value: unknown): JwksDocument {
  const record = requireRecord(value);
  if (!Array.isArray(record.keys) || record.keys.length === 0) {
    throw new Error("invalid JWKS");
  }
  const keys = record.keys.map((value) => {
    const key = requireRecord(value) as AccessJsonWebKey;
    if (
      typeof key.kid !== "string" ||
      typeof key.kty !== "string" ||
      typeof key.n !== "string" ||
      typeof key.e !== "string"
    ) {
      throw new Error("invalid JWK");
    }
    return key;
  });
  return { keys };
}

function parseIssuer(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.hostname.endsWith(".cloudflareaccess.com")
  ) {
    throw new Error("invalid Access issuer");
  }
  return url.origin;
}

function requireNonEmpty(value: string): string {
  if (value.length === 0 || value.length > 256) {
    throw new Error("invalid Access audience");
  }
  return value;
}

function decodeJsonSegment(segment: string): unknown {
  const bytes = decodeBase64Url(segment);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid base64url");
  }
  const paddingLength = (4 - (value.length % 4)) % 4;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(paddingLength);
  const decoded = atob(base64);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}
