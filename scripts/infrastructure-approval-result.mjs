import { appendFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const operation = process.argv[2];
if (process.argv.length !== 3 || !["plan", "apply-saved-plan"].includes(operation)) {
  fail("infrastructure-result-operation-invalid");
}

const source = await readBoundedStdin();
let value;
try {
  value = JSON.parse(source);
} catch {
  fail("infrastructure-result-json-invalid");
}
if (value === null || typeof value !== "object" || Array.isArray(value)) {
  fail("infrastructure-result-shape-invalid");
}

if (operation === "plan") publishPlan(value);
else if (value.status === "initialised") publishInitialState(value);
else publishApply(value);

function publishPlan(result) {
  exactKeys(result, [
    "artifact_name",
    "artifact_path",
    "artifact_sha256",
    "manifest_sha256",
    "plan_sha256",
    "status",
  ]);
  const artifactName = match(
    result.artifact_name,
    /^switchyard-infrastructure-plan-[0-9a-f]{64}$/,
    "artifact-name",
  );
  const planDigest = digest(result.plan_sha256, "plan");
  if (artifactName !== `switchyard-infrastructure-plan-${planDigest}`) {
    fail("infrastructure-result-artifact-plan-mismatch");
  }
  const artifactPath = absoluteFile(result.artifact_path);
  const artifactDigest = digest(result.artifact_sha256, "artifact");
  const manifestDigest = digest(result.manifest_sha256, "manifest");
  if (result.status !== "planned") fail("infrastructure-result-status-invalid");
  writeOutputs({
    artifact_name: artifactName,
    artifact_path: artifactPath,
    artifact_sha256: artifactDigest,
    manifest_sha256: manifestDigest,
    plan_sha256: planDigest,
  });
  appendSummary([
    "## Switchyard infrastructure plan",
    "",
    `- Saved-plan digest: \`${planDigest}\``,
    `- Plan-bundle digest: \`${artifactDigest}\``,
    `- Manifest digest: \`${manifestDigest}\``,
  ]);
}

function publishApply(result) {
  exactKeys(result, ["plan_sha256", "receipt_sha256", "replayed", "result_sha256", "status"]);
  const planDigest = digest(result.plan_sha256, "plan");
  const receiptDigest = digest(result.receipt_sha256, "receipt");
  const resultDigest = digest(result.result_sha256, "result");
  if (typeof result.replayed !== "boolean" || result.status !== "completed") {
    fail("infrastructure-result-apply-status-invalid");
  }
  writeOutputs({
    plan_sha256: planDigest,
    receipt_sha256: receiptDigest,
    replayed: String(result.replayed),
    result_sha256: resultDigest,
    status: "completed",
  });
  appendSummary([
    "## Switchyard infrastructure apply",
    "",
    `- Saved-plan digest: \`${planDigest}\``,
    `- Private receipt digest: \`${receiptDigest}\``,
    `- Result digest: \`${resultDigest}\``,
    `- Safe completed replay: \`${result.replayed}\``,
  ]);
}

function publishInitialState(result) {
  exactKeys(result, [
    "backend_state_etag",
    "backend_state_sha256",
    "lineage",
    "record_etag",
    "serial",
    "status",
  ]);
  const stateDigest = digest(result.backend_state_sha256, "backend-state");
  const lineage = match(
    result.lineage,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "lineage",
  );
  match(result.backend_state_etag, /^"[!#-~]{1,254}"$/, "backend-state-etag");
  match(result.record_etag, /^"[!#-~]{1,254}"$/, "record-etag");
  if (result.serial !== 0 || result.status !== "initialised") {
    fail("infrastructure-result-initial-state-status-invalid");
  }
  writeOutputs({
    backend_state_sha256: stateDigest,
    lineage,
    serial: "0",
    status: "initialised",
  });
  appendSummary([
    "## Switchyard initial state",
    "",
    `- State digest: \`${stateDigest}\``,
    `- State lineage: \`${lineage}\``,
    "- State serial: `0`",
  ]);
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("infrastructure-result-keys-invalid");
  }
}

function digest(value, name) {
  return match(value, /^[0-9a-f]{64}$/, `${name}-digest`);
}

function match(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`infrastructure-result-${name}-invalid`);
  }
  return value;
}

function absoluteFile(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    fail("infrastructure-result-artifact-path-invalid");
  }
  let actual;
  try {
    actual = realpathSync(value);
  } catch {
    fail("infrastructure-result-artifact-path-missing");
  }
  if (actual !== value || !value.endsWith("/switchyard-plan-bundle.zip")) {
    fail("infrastructure-result-artifact-path-invalid");
  }
  return value;
}

function writeOutputs(outputs) {
  const path = requiredOutputPath("GITHUB_OUTPUT");
  for (const [name, value] of Object.entries(outputs)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || /[\r\n]/.test(value)) {
      fail("infrastructure-result-output-invalid");
    }
    appendFileSync(path, `${name}=${value}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
  }
}

function appendSummary(lines) {
  const path = requiredOutputPath("GITHUB_STEP_SUMMARY");
  appendFileSync(path, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
}

function requiredOutputPath(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    fail(`infrastructure-result-${name.toLowerCase()}-invalid`);
  }
  return value;
}

async function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > 16 * 1024) fail("infrastructure-result-size-invalid");
    chunks.push(bytes);
  }
  if (total < 2) fail("infrastructure-result-size-invalid");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    fail("infrastructure-result-utf8-invalid");
  }
}

function fail(code) {
  process.stderr.write(`${JSON.stringify({ error: code, status: "failed" })}\n`);
  process.exit(1);
}
