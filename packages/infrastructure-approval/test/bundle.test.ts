import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyOpenTofuPlan,
  decodeStrictZip,
  PLAN_ARCHIVE_LIMITS,
  sha256Text,
  verifyPlanArchive,
} from "../src/index.js";
import {
  bytes,
  createZip,
  makeBundleFixture,
  makePlanArchive,
  planJson,
  stateIdentity,
  textOf,
} from "./fixtures.js";

describe("strict real-ZIP plan bundles", () => {
  it("decodes the exact raw ZIP bytes and verifies all four entries", async () => {
    const archive = makePlanArchive();
    const verified = await verifyPlanArchive(archive);
    assert.equal(verified.archiveBytes, archive);
    assert.equal(verified.planDigest.length, 64);
    assert.equal(verified.manifest.schemaVersion, 4);
    assert.equal(verified.manifest.state.managedResourceCount, 1);
  });

  for (const [name, transform] of [
    ["truncated archive", (value: Uint8Array) => value.slice(0, -1)],
    ["prefixed bytes", (value: Uint8Array) => Uint8Array.from([0, ...value])],
    ["changed EOCD", (value: Uint8Array) => mutate(value, value.byteLength - 22, 0)],
    ["changed local header", (value: Uint8Array) => mutate(value, 0, 0)],
    ["byte substitution", (value: Uint8Array) => mutate(value, 40, requireByte(value, 40) ^ 1)],
  ] as const) {
    it(`rejects ${name}`, async () => {
      await assert.rejects(() => verifyPlanArchive(transform(makePlanArchive())));
    });
  }

  for (const [name, path] of [
    ["traversal", "../plan.txt"],
    ["backslash", "folder\\plan.txt"],
    ["absolute path", "/plan.txt"],
    ["drive path", "C:plan.txt"],
    ["unknown entry", "other.txt"],
  ] as const) {
    it(`rejects an entry with ${name}`, async () => {
      const fixture = makeBundleFixture();
      const entries = fixture.entries.map((entry, index) =>
        index === 0 ? { ...entry, path } : entry,
      );
      await assert.rejects(() => verifyPlanArchive(createZip(entries)));
    });
  }

  it("rejects exact duplicate and ASCII-case-colliding paths", async () => {
    const fixture = makeBundleFixture();
    const exact = fixture.entries.map((entry, index) =>
      index === 1 ? { ...entry, path: "manifest.json" } : entry,
    );
    const folded = fixture.entries.map((entry, index) =>
      index === 1 ? { ...entry, path: "MANIFEST.JSON" } : entry,
    );
    await assert.rejects(() => verifyPlanArchive(createZip(exact)), /archive-duplicate-entry/);
    await assert.rejects(
      () => verifyPlanArchive(createZip(folded)),
      /archive-ascii-case-collision/,
    );
  });

  it("rejects encrypted entries, data descriptors and non-regular Unix modes", async () => {
    const fixture = makeBundleFixture();
    const first = requireEntry(fixture.entries);
    for (const entry of [
      { ...first, flags: 0x0801 },
      { ...first, flags: 0x0808 },
      { ...first, unixMode: 0o120777 },
      { ...first, unixMode: 0o040700 },
    ]) {
      await assert.rejects(() =>
        verifyPlanArchive(createZip([entry, ...fixture.entries.slice(1)])),
      );
    }
  });

  it("accepts only a complete signature-prefixed data descriptor when explicitly enabled", async () => {
    const archive = createZip([
      { contents: bytes("GitHub artifact wrapper"), dataDescriptor: true, method: 0, path: "only" },
    ]);
    const limits = {
      allowDataDescriptor: true,
      archiveBytes: 1_000,
      entryCount: 1,
      files: { only: 100 },
      maxCompressionRatio: 10,
      totalCompressedBytes: 100,
      totalUncompressedBytes: 100,
    } as const;
    const decoded = await decodeStrictZip(archive, limits);
    assert.equal(
      textOf(decoded.entries[0]?.contents ?? new Uint8Array()),
      "GitHub artifact wrapper",
    );

    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const centralOffset = view.getUint32(archive.byteLength - 22 + 16, true);
    await assert.rejects(
      () => decodeStrictZip(mutate(archive, centralOffset - 16, 0), limits),
      /archive-data-descriptor-invalid/,
    );
  });

  it("rejects unsupported compression methods and raw/total archive limits", async () => {
    const fixture = makeBundleFixture();
    const unsupported = { ...requireEntry(fixture.entries), method: 12 as 0 | 8 };
    await assert.rejects(
      () => verifyPlanArchive(createZip([unsupported, ...fixture.entries.slice(1)])),
      /archive-feature-unsupported/,
    );
    const files = Object.fromEntries(fixture.entries.map((entry) => [entry.path, 1_000_000]));
    await assert.rejects(
      () =>
        decodeStrictZip(fixture.archive, {
          archiveBytes: fixture.archive.byteLength - 1,
          entryCount: 4,
          files,
          maxCompressionRatio: 100,
          totalCompressedBytes: 1_000_000,
          totalUncompressedBytes: 1_000_000,
        }),
      /archive-size-invalid/,
    );
    await assert.rejects(
      () =>
        decodeStrictZip(fixture.archive, {
          archiveBytes: 1_000_000,
          entryCount: 4,
          files,
          maxCompressionRatio: 100,
          totalCompressedBytes: 1,
          totalUncompressedBytes: 1_000_000,
        }),
      /archive-total-size-invalid/,
    );
  });

  it("rejects excessive entry counts, per-file sizes and high-ratio streams", async () => {
    const fixture = makeBundleFixture();
    await assert.rejects(() => verifyPlanArchive(createZip(fixture.entries.slice(0, 3))));
    const oversizedManifest = bytes("x".repeat(PLAN_ARCHIVE_LIMITS.manifestBytes + 1));
    await assert.rejects(() =>
      verifyPlanArchive(
        createZip([
          { path: "manifest.json", contents: oversizedManifest, method: 0 },
          ...fixture.entries.slice(1),
        ]),
      ),
    );
    const highRatio = bytes("x".repeat(2 * 1024 * 1024));
    await assert.rejects(
      () =>
        verifyPlanArchive(
          createZip(
            fixture.entries.map((entry) =>
              entry.path === "saved-plan" ? { ...entry, contents: highRatio } : entry,
            ),
          ),
        ),
      /archive-entry-bound-invalid/,
    );
  });

  it("enforces output caps during streaming inflation", async () => {
    const zip = createZip([{ path: "only", contents: bytes("x".repeat(32_000)) }]);
    await assert.rejects(
      () =>
        decodeStrictZip(zip, {
          archiveBytes: 100_000,
          entryCount: 1,
          files: { only: 8_000 },
          maxCompressionRatio: 1_000,
          totalCompressedBytes: 100_000,
          totalUncompressedBytes: 100_000,
        }),
      /archive-entry-bound-invalid/,
    );
  });

  it("rejects trailing bytes hidden inside a deflate entry", async () => {
    const fixture = makeBundleFixture();
    const entries = fixture.entries.map((entry, index) =>
      index === 0 ? { ...entry, compressedSuffix: Uint8Array.of(0xde, 0xad) } : entry,
    );
    await assert.rejects(
      () => verifyPlanArchive(createZip(entries)),
      /archive-deflate-trailing-data/,
    );
  });

  it("rejects swapped reviewed text/JSON, a substituted entry and a different saved plan", async () => {
    const fixture = makeBundleFixture();
    const cases = [
      fixture.entries.map((entry) =>
        entry.path === "plan.txt" ? { ...entry, contents: bytes("benign other text") } : entry,
      ),
      fixture.entries.map((entry) =>
        entry.path === "plan.json"
          ? { ...entry, contents: bytes(`${textOf(planJson())} `) }
          : entry,
      ),
      fixture.entries.map((entry) =>
        entry.path === "saved-plan"
          ? { ...entry, contents: bytes("different opaque plan") }
          : entry,
      ),
    ];
    for (const entries of cases) {
      await assert.rejects(
        () => verifyPlanArchive(createZip(entries)),
        /bundle-file-digest-mismatch/,
      );
    }
  });

  it("rejects malformed, unknown and duplicate manifest fields", async () => {
    const fixture = makeBundleFixture();
    const manifest = textOf(requireEntry(fixture.entries).contents);
    for (const source of [
      "{",
      manifest.replace(/}\n$/, ',"unknown":true}\n'),
      manifest.replace('"schema_version":4', '"schema_version":4,"schema_version":4'),
    ]) {
      const entries = fixture.entries.map((entry) =>
        entry.path === "manifest.json" ? { ...entry, contents: bytes(source) } : entry,
      );
      await assert.rejects(() => verifyPlanArchive(createZip(entries)));
    }
  });
});

describe("complete Azure authority and fresh-bootstrap classification", () => {
  it("allows an exact reviewed routine foundation type", () => {
    const result = classifyOpenTofuPlan(textOf(planJson()), "foundation", stateIdentity());
    assert.equal(result.summary.authority, 0);
  });

  for (const type of [
    "azurerm_role_assignment",
    "azurerm_role_definition",
    "azurerm_federated_identity_credential",
    "azurerm_key_vault_access_policy",
    "azurerm_policy_definition",
    "azurerm_pim_eligible_role_assignment",
    "azurerm_storage_account_local_user",
    "azurerm_user_assigned_identity",
  ]) {
    it(`rejects foundation mutation of authority-bearing ${type}`, () => {
      assert.throws(
        () =>
          classifyOpenTofuPlan(
            textOf(planJson({ resourceType: type })),
            "foundation",
            stateIdentity(),
          ),
        /foundation-plan-contains-authority-change/,
      );
    });
  }

  it("inspects Key Vault RBAC/access-policy and identity-sensitive compound fields", () => {
    for (const [type, before, after] of [
      [
        "azurerm_key_vault",
        { rbac_authorization_enabled: false },
        { rbac_authorization_enabled: true },
      ],
      ["azurerm_key_vault", { access_policy: [] }, { access_policy: [{ object_id: "x" }] }],
      ["azurerm_linux_function_app", { identity: [] }, { identity: [{ type: "SystemAssigned" }] }],
      [
        "azurerm_storage_account",
        { shared_access_key_enabled: false },
        { shared_access_key_enabled: true },
      ],
    ] as const) {
      assert.throws(
        () =>
          classifyOpenTofuPlan(
            textOf(
              planJson({
                actions: ["update"],
                after,
                before,
                resourceType: type,
              }),
            ),
            "foundation",
            stateIdentity(),
          ),
        /foundation-plan-contains-authority-change/,
      );
    }
  });

  it("fails closed for an unknown future AzureRM mutable type", () => {
    assert.throws(
      () =>
        classifyOpenTofuPlan(
          textOf(planJson({ resourceType: "azurerm_future_privileged_thing" })),
          "foundation",
          stateIdentity(),
        ),
      /unknown-mutable-azurerm-type/,
    );
  });

  it("derives AzAPI ARM types from both sides and rejects disguised drift", () => {
    assert.throws(
      () =>
        classifyOpenTofuPlan(
          textOf(
            planJson({
              actions: ["update"],
              after: { type: "Microsoft.Authorization/roleAssignments@2022-04-01" },
              before: { type: "Microsoft.Storage/storageAccounts/tableServices/tables@2025-01-01" },
              resourceType: "azapi_resource",
            }),
          ),
          "foundation",
          stateIdentity(),
        ),
      /azapi-arm-type-missing-or-disagrees/,
    );
    assert.throws(
      () =>
        classifyOpenTofuPlan(
          textOf(
            planJson({
              actions: ["update"],
              after: {},
              before: {},
              resourceType: "azapi_resource",
            }),
          ),
          "foundation",
          stateIdentity(),
        ),
      /azapi-arm-type-missing-or-disagrees/,
    );
    assert.throws(
      () =>
        classifyOpenTofuPlan(
          textOf(
            planJson({
              resourceDrift: [
                {
                  address: "azapi_resource.disguised",
                  change: {
                    actions: ["update"],
                    after: { type: "Microsoft.Authorization/roleAssignments@2022-04-01" },
                    before: {
                      type: "Microsoft.Storage/storageAccounts/tableServices/tables@2025-01-01",
                    },
                  },
                  mode: "managed",
                  provider_name: "registry.opentofu.org/azure/azapi",
                  type: "azapi_resource",
                },
              ],
            }),
          ),
          "foundation",
          stateIdentity(),
        ),
      /azapi-arm-type-missing-or-disagrees/,
    );
  });

  for (const armType of [
    "Microsoft.Authorization/roleAssignments@2022-04-01",
    "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31",
    "Microsoft.KeyVault/vaults/accessPolicies@2023-07-01",
  ]) {
    it(`classifies AzAPI ${armType} as authority-bearing`, () => {
      assert.throws(
        () =>
          classifyOpenTofuPlan(
            textOf(
              planJson({
                actions: ["update"],
                after: { type: armType },
                before: { type: armType },
                resourceType: "azapi_resource",
              }),
            ),
            "foundation",
            stateIdentity(),
          ),
        /foundation-plan-contains-authority-change/,
      );
    });
  }

  it("rejects an unknown future AzAPI ARM type", () => {
    assert.throws(
      () =>
        classifyOpenTofuPlan(
          textOf(
            planJson({
              actions: ["update"],
              after: { type: "Microsoft.Future/privilegedThings@2026-01-01" },
              before: { type: "Microsoft.Future/privilegedThings@2026-01-01" },
              resourceType: "azapi_resource",
            }),
          ),
          "foundation",
          stateIdentity(),
        ),
      /unknown-mutable-azapi-arm-type/,
    );
  });

  it("allows bootstrap only for empty serial-zero create-only authority creation", () => {
    const result = classifyOpenTofuPlan(
      textOf(planJson({ authorityClass: "bootstrap" })),
      "bootstrap",
      stateIdentity("bootstrap"),
    );
    assert.equal(result.summary.authority, 1);
    assert.equal(result.priorManagedResourceCount, 0);
  });

  for (const [name, json, state] of [
    [
      "no-op managed resource",
      planJson({ actions: ["no-op"], authorityClass: "bootstrap" }),
      stateIdentity("bootstrap"),
    ],
    [
      "read existing managed resource",
      planJson({ actions: ["read"], authorityClass: "bootstrap" }),
      stateIdentity("bootstrap"),
    ],
    [
      "import",
      planJson({ authorityClass: "bootstrap", importing: { id: "existing" } }),
      stateIdentity("bootstrap"),
    ],
    [
      "resource drift",
      planJson({ authorityClass: "bootstrap", resourceDrift: [{}] }),
      stateIdentity("bootstrap"),
    ],
    [
      "routine-only create",
      planJson({ authorityClass: "bootstrap", resourceType: "azurerm_storage_account" }),
      stateIdentity("bootstrap"),
    ],
    [
      "crafted serial-zero non-empty state",
      planJson({ resourceType: "azurerm_role_assignment" }),
      stateIdentity("foundation", { serial: 0 }),
    ],
  ] as const) {
    it(`rejects bootstrap with ${name}`, () => {
      assert.throws(() => classifyOpenTofuPlan(textOf(json), "bootstrap", state));
    });
  }

  it("accepts omitted prior state only for the separately proved fresh bootstrap state", () => {
    const source = JSON.parse(textOf(planJson({ authorityClass: "bootstrap" }))) as Record<
      string,
      unknown
    >;
    delete source.prior_state;
    const result = classifyOpenTofuPlan(
      JSON.stringify(source),
      "bootstrap",
      stateIdentity("bootstrap"),
    );
    assert.equal(result.priorManagedResourceCount, 0);
    assert.equal(result.priorStateDigest, sha256Text("null\n"));

    assert.throws(
      () => classifyOpenTofuPlan(JSON.stringify(source), "foundation", stateIdentity()),
      /plan-prior-state-missing/,
    );
    assert.throws(
      () =>
        classifyOpenTofuPlan(
          JSON.stringify(source),
          "bootstrap",
          stateIdentity("bootstrap", { serial: 1 }),
        ),
      /plan-prior-state-missing/,
    );
  });

  it("rejects a managed-resource mismatch", () => {
    assert.throws(
      () =>
        classifyOpenTofuPlan(
          textOf(planJson()),
          "foundation",
          stateIdentity("foundation", {
            managedResourceCount: 2,
            managedResourcesEmpty: false,
          }),
        ),
      /plan-prior-state-backend-mismatch/,
    );
  });
});

function mutate(value: Uint8Array, offset: number, byte: number): Uint8Array {
  const result = Uint8Array.from(value);
  result[offset] = byte;
  return result;
}

function requireByte(value: Uint8Array, offset: number): number {
  const result = value[offset];
  if (result === undefined) throw new Error("byte-fixture-missing");
  return result;
}

function requireEntry<T>(entries: readonly T[]): T {
  const result = entries[0];
  if (result === undefined) throw new Error("entry-fixture-missing");
  return result;
}
