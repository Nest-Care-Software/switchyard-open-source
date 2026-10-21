import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildCanonicalZip,
  canonicalPlanManifest,
  LiveLocalPlanBundlePublicationPort,
  PLAN_ARTIFACT_RETENTION_DAYS,
  sha256Bytes,
  verifyPlanArchive,
} from "../src/index.js";
import { createZip, makeBundleFixture } from "./fixtures.js";

describe("deterministic local plan artefact", () => {
  it("creates byte-identical canonical ZIPs and publishes one immutable local file", async () => {
    const fixture = makeBundleFixture();
    const first = buildCanonicalZip(fixture.entries);
    const second = buildCanonicalZip(
      fixture.entries.map((entry) => ({ ...entry, contents: Uint8Array.from(entry.contents) })),
    );
    assert.deepEqual(first, second);
    await verifyPlanArchive(first);
    const directory = await mkdtemp(join(tmpdir(), "switchyard-plan-publication-"));
    try {
      const publisher = new LiveLocalPlanBundlePublicationPort(directory);
      const result = await publisher.publishLocalArtifact({
        archiveBytes: first,
        artifact: {
          fileName: "switchyard-plan-bundle.zip",
          immutable: true,
          name: `switchyard-infrastructure-plan-${sha256Bytes(fixture.savedPlan)}`,
          retentionDays: PLAN_ARTIFACT_RETENTION_DAYS,
        },
      });
      assert.equal(result.sha256, sha256Bytes(first));
      assert.deepEqual(Uint8Array.from(await readFile(result.artifactPath)), first);
      await assert.rejects(() =>
        publisher.publishLocalArtifact({
          archiveBytes: first,
          artifact: {
            fileName: "switchyard-plan-bundle.zip",
            immutable: true,
            name: result.artifactName,
            retentionDays: PLAN_ARTIFACT_RETENTION_DAYS,
          },
        }),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects non-deterministic order, unsafe paths, modes and timestamps", async () => {
    const fixture = makeBundleFixture();
    assert.throws(() => buildCanonicalZip([...fixture.entries].reverse()));
    assert.throws(() =>
      buildCanonicalZip(
        fixture.entries.map((entry, index) =>
          index === 0 ? { ...entry, path: "../manifest.json" } : entry,
        ),
      ),
    );
    for (const entries of [
      fixture.entries.map((entry) => ({ ...entry, unixMode: 0o100644 })),
      fixture.entries.map((entry) => ({ ...entry, dosDate: 0x22 })),
      fixture.entries.map((entry) => ({ ...entry, dosTime: 1 })),
    ]) {
      await assert.rejects(() => verifyPlanArchive(createZip(entries)));
    }
  });

  it("rejects a manifest digest substitution inside otherwise canonical bytes", async () => {
    const fixture = makeBundleFixture();
    const source = canonicalPlanManifest(fixture.manifest).replace(
      fixture.manifest.files[0].sha256,
      "f".repeat(64),
    );
    const archive = buildCanonicalZip(
      fixture.entries.map((entry) =>
        entry.path === "manifest.json"
          ? { ...entry, contents: new TextEncoder().encode(source) }
          : entry,
      ),
    );
    await assert.rejects(() => verifyPlanArchive(archive), /bundle-file-digest-mismatch/);
  });
});
