const operation = process.argv[2];
const initialStateWorkflowRef =
  "example-org/switchyard/.github/workflows/infrastructure-initialise-state.yml@refs/heads/main";
const initialStateAcknowledgement = "INITIALISE EMPTY SWITCHYARD STATE";
const initialStateDigest = "0".repeat(64);

if (process.argv.length !== 3 || !["plan", "apply-saved-plan"].includes(operation)) {
  fail("infrastructure-request-operation-invalid");
}

const jobCheckRunId = required("SWITCHYARD_JOB_CHECK_RUN_ID", /^[1-9][0-9]{0,19}$/, 20);
let request;

if (operation === "plan") {
  const authorityClass = required("SWITCHYARD_AUTHORITY_CLASS", /^(?:bootstrap|foundation)$/, 10);
  request = { operation, authorityClass, jobCheckRunId };
} else if (process.env.GITHUB_WORKFLOW_REF === initialStateWorkflowRef) {
  requireLiteral("SWITCHYARD_ARTIFACT_ID", "1");
  required("SWITCHYARD_COMMIT_SHA", /^[0-9a-f]{40}$/, 40);
  requireLiteral("SWITCHYARD_DESTRUCTIVE_ACKNOWLEDGEMENT", initialStateAcknowledgement);
  requireLiteral("SWITCHYARD_PLAN_DIGEST", initialStateDigest);
  requireLiteral("SWITCHYARD_PLAN_RUN_ID", "1");
  request = { operation: "initialise-state", jobCheckRunId };
} else {
  const approvalInputsJson = JSON.stringify({
    artifact_id: required("SWITCHYARD_ARTIFACT_ID", /^[1-9][0-9]{0,19}$/, 20),
    commit_sha: required("SWITCHYARD_COMMIT_SHA", /^[0-9a-f]{40}$/, 40),
    destructive_acknowledgement: required(
      "SWITCHYARD_DESTRUCTIVE_ACKNOWLEDGEMENT",
      /^(?:|APPROVE DESTRUCTIVE PLAN [0-9a-f]{64})$/,
      89,
      true,
    ),
    plan_digest: required("SWITCHYARD_PLAN_DIGEST", /^[0-9a-f]{64}$/, 64),
    plan_run_id: required("SWITCHYARD_PLAN_RUN_ID", /^[1-9][0-9]{0,19}$/, 20),
  });
  request = { operation, approvalInputsJson, jobCheckRunId };
}

function requireLiteral(name, expected) {
  const value = required(name, /^.{1,128}$/, 128);
  if (value !== expected) fail(`infrastructure-request-${name.toLowerCase()}-invalid`);
}

process.stdout.write(JSON.stringify(request));

function required(name, pattern, maximum, allowEmpty = false) {
  const value = process.env[name];
  delete process.env[name];
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    !pattern.test(value)
  ) {
    fail(`infrastructure-request-${name.toLowerCase()}-invalid`);
  }
  return value;
}

function fail(code) {
  process.stderr.write(`${JSON.stringify({ error: code, status: "failed" })}\n`);
  process.exit(1);
}
