import { randomUUID, timingSafeEqual } from "node:crypto";

import { parseStrictJsonObject, requireRecord } from "@switchyard/core";

import {
  exactString,
  InfrastructureApprovalError,
  managedResourceCount,
  sha256Bytes,
  stateEtag,
  stateLineage,
  stateSerial,
  type StateIdentity,
} from "./contracts.js";
import { PINNED_OPEN_TOFU_VERSION } from "./opentofu.js";

const STATE_VERSION = 4 as const;
const STATE_MAX_BYTES = 1024 * 1024;

interface ParsedOpenTofuState {
  readonly checkResults: null | readonly unknown[];
  readonly lineage: string;
  readonly outputs: Record<string, unknown>;
  readonly resources: readonly unknown[];
  readonly serial: number;
  readonly terraformVersion: string;
  readonly version: typeof STATE_VERSION;
}

export interface CanonicalInitialState {
  readonly bytes: Uint8Array;
  readonly lineage: string;
  readonly sha256: string;
}

export function createCanonicalInitialState(lineage: string = randomUUID()): CanonicalInitialState {
  const canonicalLineage = stateLineage(lineage, "initialState.lineage");
  const bytes = new TextEncoder().encode(canonicalInitialStateSource(canonicalLineage));
  return Object.freeze({ bytes, lineage: canonicalLineage, sha256: sha256Bytes(bytes) });
}

export function requireCanonicalInitialState(bytes: Uint8Array): CanonicalInitialState {
  const parsed = parseOpenTofuState(bytes);
  if (
    parsed.version !== STATE_VERSION ||
    parsed.terraformVersion !== PINNED_OPEN_TOFU_VERSION ||
    parsed.serial !== 0 ||
    Object.keys(parsed.outputs).length !== 0 ||
    parsed.resources.length !== 0 ||
    parsed.checkResults !== null
  ) {
    throw new InfrastructureApprovalError("initial-state-contract-mismatch");
  }
  const expected = new TextEncoder().encode(canonicalInitialStateSource(parsed.lineage));
  if (
    expected.byteLength !== bytes.byteLength ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(bytes))
  ) {
    throw new InfrastructureApprovalError("initial-state-not-canonical");
  }
  return Object.freeze({
    bytes: Uint8Array.from(bytes),
    lineage: parsed.lineage,
    sha256: sha256Bytes(bytes),
  });
}

export function stateIdentityFromOpenTofuState(bytes: Uint8Array, etag: string): StateIdentity {
  const parsed = parseOpenTofuState(bytes);
  let count = 0;
  for (const [index, value] of parsed.resources.entries()) {
    const resource = requireRecord(value, `state.resources[${index}]`);
    if (resource.mode !== "managed" && resource.mode !== "data") {
      throw new InfrastructureApprovalError("state-resource-mode-invalid");
    }
    if (resource.mode === "managed") count += 1;
  }
  return Object.freeze({
    backendStateDigest: sha256Bytes(bytes),
    backendStateEtag: stateEtag(etag, "state.etag"),
    lineage: parsed.lineage,
    managedResourceCount: managedResourceCount(count, "state.managedResourceCount"),
    managedResourcesEmpty: count === 0,
    serial: parsed.serial,
  });
}

function parseOpenTofuState(bytes: Uint8Array): ParsedOpenTofuState {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > STATE_MAX_BYTES
  ) {
    throw new InfrastructureApprovalError("state-bytes-out-of-bounds");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InfrastructureApprovalError("state-not-utf8");
  }
  const value = parseStrictJsonObject(
    source,
    ["version", "terraform_version", "serial", "lineage", "outputs", "resources", "check_results"],
    { maxBytes: STATE_MAX_BYTES, maxDepth: 128, path: "state" },
  );
  if (value.version !== STATE_VERSION) {
    throw new InfrastructureApprovalError("state-version-mismatch");
  }
  const terraformVersion = exactString(value.terraform_version, "state.terraform_version", 32);
  const serial = stateSerial(value.serial, "state.serial");
  const lineage = stateLineage(value.lineage, "state.lineage");
  const outputs = requireRecord(value.outputs, "state.outputs");
  if (!Array.isArray(value.resources) || value.resources.length > 4_096) {
    throw new InfrastructureApprovalError("state-resources-out-of-bounds");
  }
  if (value.check_results !== null && !Array.isArray(value.check_results)) {
    throw new InfrastructureApprovalError("state-check-results-invalid");
  }
  return Object.freeze({
    checkResults: value.check_results as null | readonly unknown[],
    lineage,
    outputs,
    resources: value.resources,
    serial,
    terraformVersion,
    version: STATE_VERSION,
  });
}

function canonicalInitialStateSource(lineage: string): string {
  return `${JSON.stringify({
    version: STATE_VERSION,
    terraform_version: PINNED_OPEN_TOFU_VERSION,
    serial: 0,
    lineage,
    outputs: {},
    resources: [],
    check_results: null,
  })}\n`;
}
