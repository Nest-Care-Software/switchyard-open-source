#!/usr/bin/env node

const MAX_RESPONSE_BYTES = 128 * 1024;
const [expectedId, mode] = process.argv.slice(2);

if (
  typeof expectedId !== "string" ||
  !/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/rg-switchyard-example-state\/providers\/Microsoft\.Storage\/storageAccounts\/swexampleapprovalreceipt\/blobServices\/default\/containers\/plan-receipts\/immutabilityPolicies\/default$/.test(
    expectedId,
  ) ||
  (mode !== "either" && mode !== "locked")
) {
  process.stderr.write("Invalid immutability-policy verifier invocation.\n");
  process.exit(2);
}

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.byteLength;
  if (size > MAX_RESPONSE_BYTES) {
    process.stderr.write("Immutability-policy response exceeded its bound.\n");
    process.exit(1);
  }
  chunks.push(chunk);
}

let policy;
try {
  policy = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  process.stderr.write("Immutability-policy response was not valid JSON.\n");
  process.exit(1);
}

const expectedType =
  "Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies";
const properties = policy?.properties;
const etag = policy?.etag;
const state = properties?.state;
if (
  policy === null ||
  Array.isArray(policy) ||
  policy.id !== expectedId ||
  policy.name !== "default" ||
  policy.type !== expectedType ||
  typeof etag !== "string" ||
  !/^"[A-Za-z0-9=+/._:-]{1,256}"$/.test(etag) ||
  properties === null ||
  Array.isArray(properties) ||
  properties?.immutabilityPeriodSinceCreationInDays !== 1 ||
  properties?.allowProtectedAppendWrites !== false ||
  properties?.allowProtectedAppendWritesAll !== false ||
  (state !== "Unlocked" && state !== "Locked") ||
  (mode === "locked" && state !== "Locked")
) {
  process.stderr.write("Immutability-policy response did not match the exact one-day contract.\n");
  process.exit(1);
}

process.stdout.write(`${state}\t${etag}\n`);
