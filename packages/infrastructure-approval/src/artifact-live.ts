import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { PlanArchiveBuilderPort, PlanBundlePublicationPort } from "./plan-engine.js";
import {
  InfrastructureApprovalError,
  PLAN_ARTIFACT_RETENTION_DAYS,
  sha256Bytes,
} from "./contracts.js";

export const PLAN_BUNDLE_FILENAME = "switchyard-plan-bundle.zip" as const;
export const CANONICAL_ZIP_UNIX_MODE = 0o100600 as const;
const ZIP_DOS_DATE_1980_01_01 = 0x21;
const ZIP_DOS_TIME_MIDNIGHT = 0;
const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY_UNIX = (3 << 8) | VERSION_NEEDED;

export class DeterministicPlanArchiveBuilder implements PlanArchiveBuilderPort {
  async build(
    entries: readonly { readonly contents: Uint8Array; readonly path: string }[],
  ): Promise<Uint8Array> {
    return buildCanonicalZip(entries);
  }
}

export function buildCanonicalZip(
  entries: readonly { readonly contents: Uint8Array; readonly path: string }[],
): Uint8Array {
  const expectedPaths = ["manifest.json", "plan.txt", "plan.json", "saved-plan"] as const;
  if (
    !Array.isArray(entries) ||
    entries.length !== expectedPaths.length ||
    entries.some((entry, index) => entry.path !== expectedPaths[index])
  ) {
    throw new InfrastructureApprovalError("canonical-zip-entry-order-invalid");
  }
  const seen = new Set<string>();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    if (
      seen.has(entry.path) ||
      !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(entry.path) ||
      !(entry.contents instanceof Uint8Array) ||
      entry.contents.byteLength < 1 ||
      entry.contents.byteLength > 32 * 1_024 * 1_024
    ) {
      throw new InfrastructureApprovalError("canonical-zip-entry-invalid");
    }
    seen.add(entry.path);
    const name = new TextEncoder().encode(entry.path);
    const checksum = crc32(entry.contents);
    const local = new Uint8Array(30 + name.byteLength + entry.contents.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_FILE_HEADER, true);
    localView.setUint16(4, VERSION_NEEDED, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, ZIP_DOS_TIME_MIDNIGHT, true);
    localView.setUint16(12, ZIP_DOS_DATE_1980_01_01, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.contents.byteLength, true);
    localView.setUint32(22, entry.contents.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.contents, 30 + name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_DIRECTORY_HEADER, true);
    centralView.setUint16(4, VERSION_MADE_BY_UNIX, true);
    centralView.setUint16(6, VERSION_NEEDED, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, ZIP_DOS_TIME_MIDNIGHT, true);
    centralView.setUint16(14, ZIP_DOS_DATE_1980_01_01, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, entry.contents.byteLength, true);
    centralView.setUint32(24, entry.contents.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, CANONICAL_ZIP_UNIX_MODE << 16, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.byteLength;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);
  return concatenate([...localParts, ...centralParts, end]);
}

export class LiveLocalPlanBundlePublicationPort implements PlanBundlePublicationPort {
  readonly #outputDirectory: string;

  constructor(outputDirectory: string) {
    if (!isAbsolute(outputDirectory)) {
      throw new InfrastructureApprovalError("artifact-output-directory-not-absolute");
    }
    this.#outputDirectory = resolve(outputDirectory);
  }

  async publishLocalArtifact(input: {
    readonly archiveBytes: Uint8Array;
    readonly artifact: {
      readonly fileName: typeof PLAN_BUNDLE_FILENAME;
      readonly immutable: true;
      readonly name: string;
      readonly retentionDays: typeof PLAN_ARTIFACT_RETENTION_DAYS;
    };
  }) {
    if (
      input.artifact.fileName !== PLAN_BUNDLE_FILENAME ||
      input.artifact.immutable !== true ||
      input.artifact.retentionDays !== PLAN_ARTIFACT_RETENTION_DAYS ||
      !/^switchyard-infrastructure-plan-[a-f0-9]{64}$/.test(input.artifact.name)
    ) {
      throw new InfrastructureApprovalError("artifact-publication-contract-invalid");
    }
    await mkdir(this.#outputDirectory, { mode: 0o700, recursive: true });
    const directory = await realpath(this.#outputDirectory);
    if (directory !== this.#outputDirectory) {
      throw new InfrastructureApprovalError("artifact-output-directory-not-canonical");
    }
    const path = join(directory, PLAN_BUNDLE_FILENAME);
    if (relative(directory, path) !== PLAN_BUNDLE_FILENAME || dirname(path) !== directory) {
      throw new InfrastructureApprovalError("artifact-output-path-invalid");
    }
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, "wx", 0o600);
      await file.writeFile(input.archiveBytes);
      await file.sync();
    } catch {
      throw new InfrastructureApprovalError("artifact-local-publication-failed");
    } finally {
      await file?.close();
    }
    const observed = await readFile(path);
    if (sha256Bytes(observed) !== sha256Bytes(input.archiveBytes)) {
      throw new InfrastructureApprovalError("artifact-local-publication-mismatch");
    }
    return Object.freeze({
      artifactName: input.artifact.name,
      artifactPath: path,
      byteLength: observed.byteLength,
      fileName: PLAN_BUNDLE_FILENAME,
      retentionDays: PLAN_ARTIFACT_RETENTION_DAYS,
      sha256: sha256Bytes(observed),
    });
  }
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const table = CRC32_TABLE[(crc ^ byte) & 0xff];
    if (table === undefined) throw new InfrastructureApprovalError("canonical-zip-crc-invalid");
    crc = table ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Object.freeze(
  Array.from({ length: 256 }, (_unused, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  }),
);
