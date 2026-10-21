import { createInflateRaw } from "node:zlib";

import { InfrastructureApprovalError } from "./contracts.js";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const UNIX_HOST = 3;
const REGULAR_FILE_TYPE = 0o100000;
const FILE_TYPE_MASK = 0o170000;

export interface StrictZipLimits {
  readonly allowDataDescriptor?: boolean;
  readonly archiveBytes: number;
  readonly entryCount: number;
  readonly exactDosDate?: number;
  readonly exactDosTime?: number;
  readonly exactUnixMode?: number;
  readonly maxCompressionRatio: number;
  readonly totalCompressedBytes: number;
  readonly totalUncompressedBytes: number;
  readonly files: Readonly<Record<string, number>>;
}

export interface DecodedZipEntry {
  readonly compressedSize: number;
  readonly contents: Uint8Array;
  readonly path: string;
  readonly uncompressedSize: number;
  readonly unixMode: number;
}

export interface DecodedZipArchive {
  readonly bytes: Uint8Array;
  readonly entries: readonly DecodedZipEntry[];
}

interface CentralEntry {
  readonly compressedSize: number;
  readonly compressionMethod: 0 | 8;
  readonly crc32: number;
  readonly dosDate: number;
  readonly dosTime: number;
  readonly flags: number;
  readonly localHeaderOffset: number;
  readonly nameBytes: Uint8Array;
  readonly path: string;
  readonly uncompressedSize: number;
  readonly unixMode: number;
}

/**
 * Decode one deliberately narrow real-ZIP profile from the exact supplied
 * bytes. No caller-supplied entry metadata is accepted or trusted.
 */
export async function decodeStrictZip(
  bytes: Uint8Array,
  limits: StrictZipLimits,
): Promise<DecodedZipArchive> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) {
    throw new InfrastructureApprovalError("archive-malformed");
  }
  if (bytes.byteLength > limits.archiveBytes) {
    throw new InfrastructureApprovalError("archive-size-invalid");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = bytes.byteLength - 22;
  if (u32(view, eocdOffset) !== END_OF_CENTRAL_DIRECTORY) {
    throw new InfrastructureApprovalError("archive-eocd-invalid");
  }
  const disk = u16(view, eocdOffset + 4);
  const centralDisk = u16(view, eocdOffset + 6);
  const diskEntries = u16(view, eocdOffset + 8);
  const totalEntries = u16(view, eocdOffset + 10);
  const centralSize = u32(view, eocdOffset + 12);
  const centralOffset = u32(view, eocdOffset + 16);
  const commentLength = u16(view, eocdOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries !== limits.entryCount ||
    commentLength !== 0 ||
    centralOffset + centralSize !== eocdOffset
  ) {
    throw new InfrastructureApprovalError("archive-central-directory-invalid");
  }

  const entries: CentralEntry[] = [];
  const exactPaths = new Set<string>();
  const foldedPaths = new Set<string>();
  let centralCursor = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (u32(view, centralCursor) !== CENTRAL_DIRECTORY_HEADER) {
      throw new InfrastructureApprovalError("archive-central-header-invalid");
    }
    const versionMadeBy = u16(view, centralCursor + 4);
    const versionNeeded = u16(view, centralCursor + 6);
    const flags = u16(view, centralCursor + 8);
    const method = u16(view, centralCursor + 10);
    const dosTime = u16(view, centralCursor + 12);
    const dosDate = u16(view, centralCursor + 14);
    const checksum = u32(view, centralCursor + 16);
    const compressedSize = u32(view, centralCursor + 20);
    const uncompressedSize = u32(view, centralCursor + 24);
    const nameLength = u16(view, centralCursor + 28);
    const extraLength = u16(view, centralCursor + 30);
    const entryCommentLength = u16(view, centralCursor + 32);
    const diskStart = u16(view, centralCursor + 34);
    const externalAttributes = u32(view, centralCursor + 38);
    const localHeaderOffset = u32(view, centralCursor + 42);
    const recordEnd = centralCursor + 46 + nameLength + extraLength + entryCommentLength;
    if (recordEnd > eocdOffset || nameLength < 1 || nameLength > 128) {
      throw new InfrastructureApprovalError("archive-central-header-invalid");
    }
    if (
      versionNeeded > 20 ||
      flags & ENCRYPTED_FLAG ||
      ((flags & DATA_DESCRIPTOR_FLAG) !== 0 && limits.allowDataDescriptor !== true) ||
      (flags & ~(UTF8_FLAG | DATA_DESCRIPTOR_FLAG)) !== 0 ||
      (method !== 0 && method !== 8) ||
      extraLength !== 0 ||
      entryCommentLength !== 0 ||
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff
    ) {
      throw new InfrastructureApprovalError("archive-feature-unsupported");
    }
    const nameBytes = bytes.subarray(centralCursor + 46, centralCursor + 46 + nameLength);
    const path = decodeAsciiPath(nameBytes);
    const folded = asciiLower(path);
    if (exactPaths.has(path)) throw new InfrastructureApprovalError("archive-duplicate-entry");
    if (foldedPaths.has(folded)) {
      throw new InfrastructureApprovalError("archive-ascii-case-collision");
    }
    exactPaths.add(path);
    foldedPaths.add(folded);
    if (!Object.hasOwn(limits.files, path)) {
      throw new InfrastructureApprovalError("archive-unknown-entry");
    }
    if (!safeArchivePath(path)) throw new InfrastructureApprovalError("archive-path-invalid");

    const host = versionMadeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    if (
      host !== UNIX_HOST ||
      (unixMode & FILE_TYPE_MASK) !== REGULAR_FILE_TYPE ||
      (limits.exactUnixMode !== undefined && unixMode !== limits.exactUnixMode) ||
      (limits.exactDosDate !== undefined && dosDate !== limits.exactDosDate) ||
      (limits.exactDosTime !== undefined && dosTime !== limits.exactDosTime)
    ) {
      throw new InfrastructureApprovalError("archive-symlink-or-non-regular");
    }
    const perFileLimit = limits.files[path];
    if (
      perFileLimit === undefined ||
      compressedSize < 1 ||
      uncompressedSize < 1 ||
      compressedSize > perFileLimit ||
      uncompressedSize > perFileLimit ||
      uncompressedSize / compressedSize > limits.maxCompressionRatio
    ) {
      throw new InfrastructureApprovalError("archive-entry-bound-invalid");
    }
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (
      totalCompressed > limits.totalCompressedBytes ||
      totalUncompressed > limits.totalUncompressedBytes
    ) {
      throw new InfrastructureApprovalError("archive-total-size-invalid");
    }
    entries.push({
      compressedSize,
      compressionMethod: method,
      crc32: checksum,
      dosDate,
      dosTime,
      flags,
      localHeaderOffset,
      nameBytes,
      path,
      uncompressedSize,
      unixMode,
    });
    centralCursor = recordEnd;
  }
  if (centralCursor !== eocdOffset) {
    throw new InfrastructureApprovalError("archive-central-directory-invalid");
  }

  const decoded: DecodedZipEntry[] = [];
  let expectedLocalOffset = 0;
  for (const entry of [...entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  )) {
    const offset = entry.localHeaderOffset;
    if (offset !== expectedLocalOffset || u32(view, offset) !== LOCAL_FILE_HEADER) {
      throw new InfrastructureApprovalError("archive-local-header-invalid");
    }
    const versionNeeded = u16(view, offset + 4);
    const flags = u16(view, offset + 6);
    const method = u16(view, offset + 8);
    const dosTime = u16(view, offset + 10);
    const dosDate = u16(view, offset + 12);
    const checksum = u32(view, offset + 14);
    const compressedSize = u32(view, offset + 18);
    const uncompressedSize = u32(view, offset + 22);
    const nameLength = u16(view, offset + 26);
    const extraLength = u16(view, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const usesDataDescriptor = (entry.flags & DATA_DESCRIPTOR_FLAG) !== 0;
    const dataEnd = dataStart + entry.compressedSize;
    const descriptorEnd = usesDataDescriptor ? dataEnd + 16 : dataEnd;
    if (
      versionNeeded > 20 ||
      flags !== entry.flags ||
      method !== entry.compressionMethod ||
      dosTime !== entry.dosTime ||
      dosDate !== entry.dosDate ||
      (usesDataDescriptor
        ? checksum !== 0 || compressedSize !== 0 || uncompressedSize !== 0
        : checksum !== entry.crc32 ||
          compressedSize !== entry.compressedSize ||
          uncompressedSize !== entry.uncompressedSize) ||
      nameLength !== entry.nameBytes.byteLength ||
      extraLength !== 0 ||
      descriptorEnd > centralOffset ||
      !equalBytes(bytes.subarray(nameStart, nameStart + nameLength), entry.nameBytes)
    ) {
      throw new InfrastructureApprovalError("archive-local-central-mismatch");
    }
    if (
      usesDataDescriptor &&
      (u32(view, dataEnd) !== DATA_DESCRIPTOR_SIGNATURE ||
        u32(view, dataEnd + 4) !== entry.crc32 ||
        u32(view, dataEnd + 8) !== entry.compressedSize ||
        u32(view, dataEnd + 12) !== entry.uncompressedSize)
    ) {
      throw new InfrastructureApprovalError("archive-data-descriptor-invalid");
    }
    const compressed = bytes.subarray(dataStart, dataEnd);
    const contents =
      entry.compressionMethod === 0
        ? Uint8Array.from(compressed)
        : await inflateBounded(compressed, entry.uncompressedSize);
    if (contents.byteLength !== entry.uncompressedSize || crc32(contents) !== entry.crc32) {
      throw new InfrastructureApprovalError("archive-entry-integrity-invalid");
    }
    decoded.push(
      Object.freeze({
        compressedSize: entry.compressedSize,
        contents,
        path: entry.path,
        uncompressedSize: entry.uncompressedSize,
        unixMode: entry.unixMode,
      }),
    );
    expectedLocalOffset = descriptorEnd;
  }
  if (expectedLocalOffset !== centralOffset) {
    throw new InfrastructureApprovalError("archive-local-layout-invalid");
  }
  return Object.freeze({ bytes, entries: Object.freeze(decoded) });
}

async function inflateBounded(input: Uint8Array, expectedBytes: number): Promise<Uint8Array> {
  const inflater = createInflateRaw();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    inflater.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
    for await (const rawChunk of inflater) {
      const chunk = rawChunk as Buffer;
      if (total + chunk.byteLength > expectedBytes) {
        throw new InfrastructureApprovalError("archive-inflated-output-exceeded");
      }
      chunks.push(Uint8Array.from(chunk));
      total += chunk.byteLength;
    }
    if (inflater.bytesWritten !== input.byteLength) {
      throw new InfrastructureApprovalError("archive-deflate-trailing-data");
    }
  } catch (error) {
    inflater.destroy();
    if (error instanceof InfrastructureApprovalError) throw error;
    throw new InfrastructureApprovalError("archive-deflate-stream-invalid");
  } finally {
    inflater.destroy();
  }
  if (total !== expectedBytes) {
    throw new InfrastructureApprovalError("archive-inflated-size-mismatch");
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeAsciiPath(bytes: Uint8Array): string {
  let result = "";
  for (const value of bytes) {
    if (value < 0x20 || value > 0x7e) {
      throw new InfrastructureApprovalError("archive-path-encoding-invalid");
    }
    result += String.fromCharCode(value);
  }
  return result;
}

function safeArchivePath(path: string): boolean {
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.includes("\u0000")
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function u16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) {
    throw new InfrastructureApprovalError("archive-header-truncated");
  }
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) {
    throw new InfrastructureApprovalError("archive-header-truncated");
  }
  return view.getUint32(offset, true);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const tableValue = CRC32_TABLE[(crc ^ byte) & 0xff];
    if (tableValue === undefined) throw new InfrastructureApprovalError("crc-table-invalid");
    crc = tableValue ^ (crc >>> 8);
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
