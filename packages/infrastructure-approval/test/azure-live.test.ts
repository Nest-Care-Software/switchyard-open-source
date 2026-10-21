import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AzureApprovalBlobTransport,
  createCanonicalInitialState,
  INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP,
  LiveAzureApplyIntentReceiptPort,
  LiveAzureApplyLeasePort,
  LiveAzureAuthoritativeStatePort,
  LiveAzureInitialStateBootstrap,
  LiveAzurePlannerStatePort,
  LiveAzurePrivatePlanReceiptPort,
  makeIntent,
  type StartedApplyIntentReceipt,
  sha256Bytes,
  sha256Text,
} from "../src/index.js";
import {
  APPROVAL_RUN_ID,
  ARTIFACT_ID,
  bytes,
  COMMIT_SHA,
  identitySession,
  LINEAGE,
  MANIFEST_CREATED_AT,
  PLAN_RUN_ID,
  POLICY,
  RAW_APPLY_TOKEN,
  RAW_PLAN_TOKEN,
} from "./fixtures.js";

const CONFIG = {
  applyControlContainerName: "apply-control" as const,
  receiptContainerName: "plan-receipts" as const,
  receiptStorageAccountName: "receiptfixture",
  stateBackend: POLICY.backend,
};

describe("live Azure infrastructure approval adapters", () => {
  it("gives the planner one exact authenticated state GET and no blob write or lease path", async () => {
    const service = new FakeBlobService();
    const initial = createCanonicalInitialState(LINEAGE);
    service.seed("tfstate", POLICY.backend.key, initial.bytes);
    const session = sessionFor("planner");
    const planner = new LiveAzurePlannerStatePort({
      config: CONFIG,
      policy: POLICY,
      transport: transport(service),
    });
    const identity = await planner.readIdentity({
      backend: POLICY.backend,
      plannerSession: session,
    });
    assert.equal(identity.backendStateDigest, initial.sha256);
    assert.deepEqual(
      service.requests.map((request) => request.method),
      ["GET"],
    );
    assert.equal(
      service.requests[0]?.headers.get("authorization"),
      `Bearer ${tokenFor("planner")}`,
    );
    assert.equal((planner as { withLease?: unknown }).withLease, undefined);
  });

  it("fails closed when authoritative state is absent", async () => {
    const service = new FakeBlobService();
    const state = new LiveAzureAuthoritativeStatePort({
      config: CONFIG,
      policy: POLICY,
      transport: transport(service),
    });
    await assert.rejects(
      () =>
        state.readIdentity({
          backend: POLICY.backend,
          session: sessionFor("foundation-applier"),
        }),
      /azure-storage-status-404/,
    );
    assert.deepEqual(
      service.requests.map((request) => request.method),
      ["GET"],
    );
  });

  it("classifies only reviewed Azure Storage error headers without reading error bodies", async () => {
    for (const [header, expected] of [
      ["ConditionHeadersNotSupported", "condition-headers-not-supported"],
      ["EmptyMetadataKey", "empty-metadata-key"],
      ["InvalidAuthenticationInfo", "invalid-authentication-info"],
      ["InvalidHeaderValue", "invalid-header-value"],
      ["InvalidHttpVerb", "invalid-http-verb"],
      ["InvalidInput", "invalid-input"],
      ["InvalidMd5", "invalid-md5"],
      ["InvalidMetadata", "invalid-metadata"],
      ["InvalidQueryParameterValue", "invalid-query-parameter-value"],
      ["InvalidResourceName", "invalid-resource-name"],
      ["InvalidUri", "invalid-uri"],
      ["InvalidXmlDocument", "invalid-xml-document"],
      ["InvalidXmlNodeValue", "invalid-xml-node-value"],
      ["Md5Mismatch", "md5-mismatch"],
      ["MetadataTooLarge", "metadata-too-large"],
      ["MissingRequiredHeader", "missing-required-header"],
      ["MissingRequiredQueryParameter", "missing-required-query-parameter"],
      ["MissingRequiredXmlNode", "missing-required-xml-node"],
      ["MultipleConditionHeadersNotSupported", "multiple-condition-headers-not-supported"],
      ["OutOfRangeInput", "out-of-range-input"],
      ["OutOfRangeQueryParameterValue", "out-of-range-query-parameter-value"],
      ["RequestUrlFailedToParse", "request-url-failed-to-parse"],
      ["UnsupportedHeader", "unsupported-header"],
      ["UnsupportedQueryParameter", "unsupported-query-parameter"],
      ["UnsupportedXmlNode", "unsupported-xml-node"],
      ["unreviewed-sensitive-value", "error-code-unreviewed"],
      [null, "error-code-absent"],
    ] as const) {
      let bodyCancelled = false;
      const stream = new ReadableStream({
        cancel() {
          bodyCancelled = true;
        },
        start(controller) {
          controller.enqueue(bytes("must not be read or reported"));
        },
      });
      const state = new LiveAzureAuthoritativeStatePort({
        config: CONFIG,
        policy: POLICY,
        transport: new AzureApprovalBlobTransport({
          fetch: async () =>
            new Response(stream, {
              headers: header === null ? {} : { "x-ms-error-code": header },
              status: 400,
            }),
          now: () => Date.parse("2026-08-25T12:00:00.000Z"),
        }),
      });
      const expectedError = `azure-storage-status-400-${expected}`;
      await assert.rejects(
        () =>
          state.readIdentity({
            backend: POLICY.backend,
            session: sessionFor("foundation-applier"),
          }),
        (error: unknown) => {
          assert.equal(error instanceof Error ? error.message : String(error), expectedError);
          assert.equal(String(error).includes("unreviewed-sensitive-value"), false);
          assert.equal(String(error).includes("must not be read or reported"), false);
          return true;
        },
      );
      assert.equal(bodyCancelled, true);
    }
  });

  it("creates or verifies the content-addressed receipt conditionally under the exact applier session", async () => {
    const service = new FakeBlobService();
    const session = sessionFor("foundation-applier");
    const adapter = new LiveAzurePrivatePlanReceiptPort({
      config: CONFIG,
      policy: POLICY,
      transport: transport(service),
    });
    const archive = bytes("exact plan archive");
    const digest = sha256Bytes(archive);
    const key = `plans/${"a".repeat(64)}/${digest}.zip`;
    const first = await adapter.ensurePrivateReceipt({
      archiveBytes: archive,
      contentAddressedKey: key,
      session,
    });
    const second = await adapter.ensurePrivateReceipt({
      archiveBytes: archive,
      contentAddressedKey: key,
      session,
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.sha256, digest);
    assert.equal(service.requests[0]?.headers.get("if-none-match"), "*");
    await assert.rejects(
      () =>
        adapter.ensurePrivateReceipt({
          archiveBytes: bytes("substituted"),
          contentAddressedKey: key,
          session,
        }),
      /plan-receipt-key-mismatch/,
    );
    await assert.rejects(
      () =>
        adapter.ensurePrivateReceipt({
          archiveBytes: archive,
          contentAddressedKey: key,
          session: sessionFor("planner"),
        }),
      /azure-session-identity-not-allowed/,
    );
  });

  it("uses authenticated conditional lease and intent writes and rechecks state under the lease", async () => {
    const service = new FakeBlobService();
    const initial = createCanonicalInitialState(LINEAGE);
    service.seed("tfstate", POLICY.backend.key, initial.bytes);
    const session = sessionFor("foundation-applier");
    const blobTransport = transport(service);
    const state = new LiveAzureAuthoritativeStatePort({
      config: CONFIG,
      policy: POLICY,
      transport: blobTransport,
    });
    const leases = new LiveAzureApplyLeasePort({
      config: CONFIG,
      policy: POLICY,
      transport: blobTransport,
    });
    const intents = new LiveAzureApplyIntentReceiptPort({
      config: CONFIG,
      policy: POLICY,
      transport: blobTransport,
    });
    await leases.withLease({
      key: INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP,
      session,
      work: async (lease) => {
        const observed = await state.readIdentityUnderLease({
          backend: POLICY.backend,
          lease,
          session,
        });
        const started = startedIntent(observed);
        const created = await intents.createStarted({ proposed: started, session });
        assert.equal(created.outcome, "created");
        assert.equal(created.receipt.receiptDigest, started.receiptDigest);
        assert.equal(
          (await intents.createStarted({ proposed: started, session })).outcome,
          "exists",
        );
        const failed = makeIntent({
          ...withoutDigest(started),
          finishedAt: "2026-08-25T12:05:01.000Z",
          resultDigest: sha256Text("failed"),
          status: "failed",
        });
        const replaced = await intents.replace({
          expectedReceiptDigest: started.receiptDigest,
          next: failed,
          planDigest: started.planDigest,
          session,
        });
        assert.deepEqual(JSON.parse(JSON.stringify(replaced)), failed);
      },
    });
    const leaseActions = service.requests
      .map((request) => request.headers.get("x-ms-lease-action"))
      .filter(Boolean);
    assert.deepEqual(leaseActions, ["acquire", "release"]);
    assert.ok(service.requests.some((request) => request.headers.has("if-match")));
    assert.ok(
      service.requests.every(
        (request) =>
          request.headers.get("authorization") === `Bearer ${tokenFor("foundation-applier")}`,
      ),
    );
  });

  it("creates canonical state and its SHA-256 plus ETag record only from total absence", async () => {
    const service = new FakeBlobService();
    const bootstrap = new LiveAzureInitialStateBootstrap({
      config: CONFIG,
      lineage: () => LINEAGE,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      policy: POLICY,
      transport: transport(service),
    });
    const result = await bootstrap.initialise(sessionFor("bootstrap-applier"));
    assert.equal(result.identity.lineage, LINEAGE);
    assert.equal(result.identity.serial, 0);
    assert.equal(result.identity.managedResourcesEmpty, true);
    const record = JSON.parse(
      new TextDecoder().decode(service.get("apply-control", "foundation/initial-state.json")),
    );
    assert.equal(record.state_sha256, result.identity.backendStateDigest);
    assert.equal(record.state_etag, result.identity.backendStateEtag);
    const historyRequests = service.requests.filter(
      (request) => request.url.searchParams.get("comp") === "list",
    );
    assert.equal(historyRequests.length, 2);
    for (const request of historyRequests) {
      assert.equal(
        request.url.searchParams.get("include"),
        "snapshots,uncommittedblobs,deleted,versions,deletedwithversions",
      );
      assert.equal(request.url.searchParams.has("prefix"), false);
      assert.equal(request.url.searchParams.get("maxresults"), "100");
    }
    const stateReads = service.requests.filter(
      (request) =>
        request.method === "GET" &&
        decodeURIComponent(request.url.pathname.slice(1)) === `tfstate/${POLICY.backend.key}`,
    );
    assert.equal(stateReads.length, 2);
    assert.ok(stateReads.every((request) => request.headers.has("x-ms-lease-id")));
    const stateCreate = service.requests.find(
      (request) =>
        request.method === "PUT" &&
        decodeURIComponent(request.url.pathname.slice(1)) === `tfstate/${POLICY.backend.key}`,
    );
    assert.equal(
      stateCreate?.headers.get("x-ms-meta-switchyard_sha256"),
      result.identity.backendStateDigest,
    );
    assert.equal(stateCreate?.headers.has("x-ms-meta-switchyard-sha256"), false);
    await assert.rejects(
      () => bootstrap.initialise(sessionFor("bootstrap-applier")),
      /initial-state-history-pre-exists/,
    );
  });

  for (const retainedKind of [
    "current",
    "previous-version",
    "deleted-version",
    "snapshot",
    "uncommitted",
  ] as const) {
    it(`rejects an exact ${retainedKind} state blob retained by Azure`, async () => {
      const service = new FakeBlobService();
      service.retain("tfstate", POLICY.backend.key, retainedKind);
      await assert.rejects(
        () => bootstrap(service).initialise(sessionFor("bootstrap-applier")),
        /initial-state-history-pre-exists/,
      );
      assert.equal(
        service.requests.some((request) => request.headers.get("if-none-match") === "*"),
        false,
      );
    });
  }

  it("compares decoded exact names, permits prefix collisions and follows bounded pagination", async () => {
    const service = new FakeBlobService();
    service.setHistoryPages("tfstate", [
      historyPage({ names: [`${POLICY.backend.key}.backup`], nextMarker: "page-two" }),
      historyPage({ marker: "page-two", names: [], nextMarker: null }),
    ]);
    const result = await bootstrap(service).initialise(sessionFor("bootstrap-applier"));
    assert.equal(result.identity.lineage, LINEAGE);
    const stateLists = service.requests.filter(
      (request) =>
        request.url.pathname === "/tfstate" && request.url.searchParams.get("comp") === "list",
    );
    assert.equal(stateLists.length, 2);
    assert.equal(stateLists[1]?.url.searchParams.get("marker"), "page-two");
  });

  it("rejects an exact retained name after Azure XML percent-decoding", async () => {
    const service = new FakeBlobService();
    const ordinary = historyPage({ names: [POLICY.backend.key] });
    const encodedBody = ordinary.body.replace(
      `<Name>${POLICY.backend.key}</Name>`,
      `<Name Encoded="true">%73${encodeURIComponent(POLICY.backend.key).slice(1)}</Name>`,
    );
    service.setHistoryPages("tfstate", [
      { body: encodedBody, headers: xmlHeaders(bytes(encodedBody).byteLength) },
    ]);
    await assert.rejects(
      () => bootstrap(service).initialise(sessionFor("bootstrap-applier")),
      /initial-state-history-pre-exists/,
    );
  });

  it("rejects a retained initial-state record after safely leasing the new state", async () => {
    const service = new FakeBlobService();
    service.retain("apply-control", "foundation/initial-state.json", "deleted-version");
    await assert.rejects(
      () => bootstrap(service).initialise(sessionFor("bootstrap-applier")),
      /initial-state-history-pre-exists/,
    );
    assert.deepEqual(
      service.requests.map((request) => request.headers.get("x-ms-lease-action")).filter(Boolean),
      ["acquire", "release"],
    );
  });

  it("fails closed on malformed, truncated, over-limit and non-terminating history responses", async () => {
    const emptyPage = historyPage();
    const ambiguousBody = emptyPage.body.replace(
      "<NextMarker></NextMarker>",
      "<NextMarker></NextMarker><NextMarker></NextMarker>",
    );
    const fixtures: ReadonlyArray<readonly [string, readonly HistoryPage[]]> = [
      ["malformed", [{ body: "<EnumerationResults>", headers: xmlHeaders(20) }]],
      [
        "ambiguous",
        [{ body: ambiguousBody, headers: xmlHeaders(bytes(ambiguousBody).byteLength) }],
      ],
      [
        "truncated",
        [
          {
            body: historyPage().body,
            headers: xmlHeaders(bytes(historyPage().body).byteLength + 1),
          },
        ],
      ],
      ["over-limit", [{ body: "x", headers: xmlHeaders(256 * 1024 + 1) }]],
      [
        "repeated-marker",
        [
          historyPage({ nextMarker: "same-marker" }),
          historyPage({ marker: "same-marker", nextMarker: "same-marker" }),
        ],
      ],
      [
        "non-terminating",
        Array.from({ length: 8 }, (_, index) =>
          historyPage({
            marker: index === 0 ? null : `page-${index}`,
            nextMarker: `page-${index + 1}`,
          }),
        ),
      ],
    ];
    for (const [name, pages] of fixtures) {
      const service = new FakeBlobService();
      service.setHistoryPages("tfstate", pages);
      await assert.rejects(
        () => bootstrap(service).initialise(sessionFor("bootstrap-applier")),
        /azure-(?:history|storage)-/,
        name,
      );
    }
  });

  it("keeps the protected state coherent when an injected concurrent writer races", async () => {
    const service = new FakeBlobService();
    service.injectConcurrentStateWrite(bytes("not canonical"));
    const result = await bootstrap(service).initialise(sessionFor("bootstrap-applier"));
    assert.equal(service.concurrentWriteStatus, 412);
    assert.equal(
      result.identity.backendStateDigest,
      sha256Bytes(service.get("tfstate", POLICY.backend.key)),
    );
  });

  it("fails on lease loss before the final state proof", async () => {
    const service = new FakeBlobService();
    service.loseStateLeaseBeforeFinalRead = true;
    await assert.rejects(
      () => bootstrap(service).initialise(sessionFor("bootstrap-applier")),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some((entry) => String(entry).includes("azure-storage-status-412")),
    );
  });

  it("fails when the final state differs despite an injected lease bypass", async () => {
    const service = new FakeBlobService();
    service.mutateStateBeforeFinalRead = createCanonicalInitialState(
      "12345678-1234-4123-8123-123456789abc",
    ).bytes;
    await assert.rejects(
      () => bootstrap(service).initialise(sessionFor("bootstrap-applier")),
      /initial-state-roundtrip-mismatch/,
    );
  });

  it("fails when identical final bytes carry a raced ETag", async () => {
    const service = new FakeBlobService();
    service.mutateStateBeforeFinalRead = createCanonicalInitialState(LINEAGE).bytes;
    await assert.rejects(
      () => bootstrap(service).initialise(sessionFor("bootstrap-applier")),
      /initial-state-final-mismatch/,
    );
  });

  it("never reports success when releasing the state lease is ambiguous", async () => {
    const service = new FakeBlobService();
    service.failStateLeaseRelease = true;
    await assert.rejects(
      () => bootstrap(service).initialise(sessionFor("bootstrap-applier")),
      /azure-storage-status-500/,
    );
  });

  it("bounds Azure response bodies before parsing", async () => {
    const response = new Response(Buffer.from(bytes("x".repeat(1024 * 1024 + 1))), {
      headers: { "content-length": String(1024 * 1024 + 1) },
      status: 200,
    });
    const adapter = new LiveAzureAuthoritativeStatePort({
      config: CONFIG,
      policy: POLICY,
      transport: new AzureApprovalBlobTransport({
        fetch: async () => response,
        now: () => Date.parse("2026-08-25T12:00:00.000Z"),
      }),
    });
    await assert.rejects(
      () =>
        adapter.readIdentity({
          backend: POLICY.backend,
          session: sessionFor("foundation-applier"),
        }),
      /azure-storage-response-too-large/,
    );
  });
});

type Identity = "bootstrap-applier" | "foundation-applier" | "planner";

function sessionFor<T extends Identity>(identity: T) {
  return identitySession(identity, identity === "planner" ? RAW_PLAN_TOKEN : RAW_APPLY_TOKEN, {
    credential: {
      async getToken() {
        return {
          expiresOnTimestamp: Date.parse("2026-08-25T13:00:00.000Z"),
          token: tokenFor(identity),
        };
      },
    },
  }) as ReturnType<typeof identitySession> & { readonly identity: T };
}

function tokenFor(identity: Identity): string {
  return `${identity}-explicit-session-token.`.repeat(3);
}

function transport(service: FakeBlobService): AzureApprovalBlobTransport {
  return new AzureApprovalBlobTransport({
    fetch: service.fetch,
    now: () => Date.parse("2026-08-25T12:00:00.000Z"),
  });
}

function bootstrap(service: FakeBlobService): LiveAzureInitialStateBootstrap {
  return new LiveAzureInitialStateBootstrap({
    config: CONFIG,
    lineage: () => LINEAGE,
    now: () => new Date("2026-08-25T12:00:00.000Z"),
    policy: POLICY,
    transport: transport(service),
  });
}

function startedIntent(
  state: ReturnType<typeof import("../src/index.js").stateIdentityFromOpenTofuState>,
): StartedApplyIntentReceipt {
  return makeIntent({
    approvalRunId: APPROVAL_RUN_ID,
    archiveDigest: "a".repeat(64),
    artifactId: ARTIFACT_ID,
    authorityClass: "foundation",
    commandDigest: "b".repeat(64),
    commitSha: COMMIT_SHA,
    manifestDigest: "c".repeat(64),
    planDigest: "d".repeat(64),
    planRunId: PLAN_RUN_ID,
    savedPlanDigest: "e".repeat(64),
    startedAt: MANIFEST_CREATED_AT,
    stateBefore: state,
    status: "started",
  }) as StartedApplyIntentReceipt;
}

function withoutDigest<T extends { readonly receiptDigest: string }>(
  value: T,
): Omit<T, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...body } = value;
  return body;
}

class FakeBlobService {
  readonly requests: Array<{
    readonly headers: Headers;
    readonly method: string;
    readonly url: URL;
  }> = [];
  readonly #blobs = new Map<
    string,
    { bytes: Uint8Array; etag: string; metadata: Record<string, string> }
  >();
  readonly #history = new Map<string, Array<{ kind: RetainedKind; name: string }>>();
  readonly #historyPages = new Map<string, HistoryPage[]>();
  readonly #leases = new Map<string, string>();
  #concurrentStateWrite: Uint8Array | null = null;
  #revision = 0;
  concurrentWriteStatus: number | null = null;
  failStateLeaseRelease = false;
  loseStateLeaseBeforeFinalRead = false;
  mutateStateBeforeFinalRead: Uint8Array | null = null;

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    this.requests.push({ headers, method, url });
    if (url.searchParams.get("comp") === "list") {
      return this.#list(decodeURIComponent(url.pathname.slice(1)), url);
    }
    const key = decodeURIComponent(url.pathname.slice(1));
    if (url.search === "?comp=lease") return this.#lease(key, headers);
    if (method === "HEAD") return this.#blobs.has(key) ? this.#response(key, null) : response(404);
    if (method === "GET") {
      if (key === `tfstate/${POLICY.backend.key}` && headers.has("x-ms-lease-id")) {
        if (headers.get("x-ms-lease-id") !== this.#leases.get(key)) return response(412);
        const stateReadCount = this.requests.filter(
          (request) =>
            request.method === "GET" && decodeURIComponent(request.url.pathname.slice(1)) === key,
        ).length;
        if (stateReadCount === 2 && this.mutateStateBeforeFinalRead !== null) {
          this.#forceStateMutation(this.mutateStateBeforeFinalRead);
        }
      }
      const result = this.#blobs.has(key) ? this.#response(key) : response(404);
      if (key === "apply-control/foundation/initial-state.json") {
        if (this.loseStateLeaseBeforeFinalRead) {
          this.#leases.delete(`tfstate/${POLICY.backend.key}`);
        }
      }
      return result;
    }
    if (method !== "PUT") return response(405);
    const current = this.#blobs.get(key);
    const activeLease = this.#leases.get(key);
    if (activeLease !== undefined && headers.get("x-ms-lease-id") !== activeLease) {
      return response(412);
    }
    if (headers.get("if-none-match") === "*" && current !== undefined) return response(412);
    if (headers.has("if-match") && headers.get("if-match") !== current?.etag) return response(412);
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
    const metadata: Record<string, string> = {};
    for (const [name, value] of headers) {
      if (name.startsWith("x-ms-meta-")) metadata[name] = value;
    }
    const etag = `"etag-${++this.#revision}"`;
    this.#blobs.set(key, { bytes: body, etag, metadata });
    return response(201, null, { etag, "last-modified": "Tue, 25 Aug 2026 12:00:00 GMT" });
  };

  seed(container: string, name: string, contents: Uint8Array): void {
    this.#blobs.set(`${container}/${name}`, {
      bytes: Uint8Array.from(contents),
      etag: `"etag-${++this.#revision}"`,
      metadata: { "x-ms-meta-switchyard_sha256": sha256Bytes(contents) },
    });
  }

  get(container: string, name: string): Uint8Array {
    const value = this.#blobs.get(`${container}/${name}`);
    if (value === undefined) throw new Error("fixture blob missing");
    return value.bytes;
  }

  injectConcurrentStateWrite(contents: Uint8Array): void {
    this.#concurrentStateWrite = Uint8Array.from(contents);
  }

  retain(container: string, name: string, kind: RetainedKind): void {
    const entries = this.#history.get(container) ?? [];
    entries.push({ kind, name });
    this.#history.set(container, entries);
    if (kind === "current") this.seed(container, name, bytes("retained current blob"));
  }

  setHistoryPages(container: string, pages: readonly HistoryPage[]): void {
    this.#historyPages.set(
      container,
      pages.map((page) => ({ body: page.body, headers: { ...page.headers } })),
    );
  }

  #lease(key: string, headers: Headers): Response {
    const action = headers.get("x-ms-lease-action");
    if (action === "acquire") {
      if (this.#leases.has(key)) return response(409);
      const leaseId = headers.get("x-ms-proposed-lease-id");
      if (leaseId === null || !this.#blobs.has(key)) return response(400);
      this.#leases.set(key, leaseId);
      return response(201, null, { "x-ms-lease-id": leaseId });
    }
    if (action === "release" && headers.get("x-ms-lease-id") === this.#leases.get(key)) {
      if (key === `tfstate/${POLICY.backend.key}` && this.failStateLeaseRelease) {
        return response(500);
      }
      this.#leases.delete(key);
      return response(200);
    }
    return response(412);
  }

  #list(container: string, url: URL): Response {
    if (container === "apply-control" && this.#concurrentStateWrite !== null) {
      const stateKey = `tfstate/${POLICY.backend.key}`;
      if (this.#leases.has(stateKey)) {
        this.concurrentWriteStatus = 412;
      } else {
        this.#forceStateMutation(this.#concurrentStateWrite);
        this.concurrentWriteStatus = 201;
      }
      this.#concurrentStateWrite = null;
    }
    const overrides = this.#historyPages.get(container);
    if (overrides !== undefined) {
      const page = overrides.shift();
      if (page === undefined) return response(500);
      return response(200, bytes(page.body), page.headers);
    }
    const entries = [
      ...Array.from(this.#blobs.keys())
        .filter((key) => key.startsWith(`${container}/`))
        .map((key) => ({ kind: "current" as const, name: key.slice(container.length + 1) })),
      ...(this.#history.get(container) ?? []).filter((entry) => entry.kind !== "current"),
    ];
    const page = historyPage({
      container,
      marker: url.searchParams.get("marker"),
      names: entries.map((entry) => entry.name),
      nextMarker: null,
      retainedKinds: entries.map((entry) => entry.kind),
    });
    return response(200, bytes(page.body), page.headers);
  }

  #forceStateMutation(contents: Uint8Array): void {
    const key = `tfstate/${POLICY.backend.key}`;
    this.#blobs.set(key, {
      bytes: Uint8Array.from(contents),
      etag: `"etag-${++this.#revision}"`,
      metadata: { "x-ms-meta-switchyard_sha256": sha256Bytes(contents) },
    });
  }

  #response(key: string, body: Uint8Array | null | undefined = undefined): Response {
    const blob = this.#blobs.get(key);
    if (blob === undefined) return response(404);
    return response(200, body === undefined ? blob.bytes : body, {
      "content-length": String(blob.bytes.byteLength),
      etag: blob.etag,
      "last-modified": "Tue, 25 Aug 2026 12:00:00 GMT",
      ...blob.metadata,
    });
  }
}

type RetainedKind = "current" | "deleted-version" | "previous-version" | "snapshot" | "uncommitted";

interface HistoryPage {
  readonly body: string;
  readonly headers: Record<string, string>;
}

function historyPage(
  options: {
    readonly container?: string;
    readonly marker?: string | null;
    readonly names?: readonly string[];
    readonly nextMarker?: string | null;
    readonly retainedKinds?: readonly RetainedKind[];
  } = {},
): HistoryPage {
  const container = options.container ?? "tfstate";
  const marker = options.marker ?? null;
  const names = options.names ?? [];
  const nextMarker = options.nextMarker ?? null;
  const kinds = options.retainedKinds ?? names.map(() => "current" as const);
  const blobs = names
    .map((name, index) => {
      const kind = kinds[index] ?? "current";
      const evidence =
        kind === "previous-version"
          ? "<VersionId>2026-08-25T00:00:00.0000000Z</VersionId>"
          : kind === "deleted-version"
            ? "<VersionId>2026-08-25T00:00:00.0000000Z</VersionId><Deleted>true</Deleted>"
            : kind === "snapshot"
              ? "<Snapshot>2026-08-25T00:00:00.0000000Z</Snapshot>"
              : kind === "uncommitted"
                ? "<Properties><BlobType>BlockBlob</BlobType></Properties>"
                : "";
      return `<Blob><Name>${xmlEscape(name)}</Name>${evidence}</Blob>`;
    })
    .join("");
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<EnumerationResults ServiceEndpoint="https://${POLICY.backend.storageAccountName}.blob.core.windows.net/" ContainerName="${xmlEscape(container)}">` +
    `${marker === null ? "" : `<Marker>${xmlEscape(marker)}</Marker>`}<MaxResults>100</MaxResults>` +
    `<Blobs>${blobs}</Blobs><NextMarker>${xmlEscape(nextMarker ?? "")}</NextMarker>` +
    `</EnumerationResults>`;
  return { body, headers: xmlHeaders(bytes(body).byteLength) };
}

function xmlHeaders(contentLength: number): Record<string, string> {
  return { "content-length": String(contentLength), "content-type": "application/xml" };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function response(
  status: number,
  body: Uint8Array | null = null,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === null ? null : Buffer.from(body), { headers, status });
}
