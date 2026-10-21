#!/usr/bin/env node

const MAX_INPUT_BYTES = 32 * 1024;
const subscriptionId = "a0000000-0000-4000-8000-000000000001";
const resourceGroup = "rg-switchyard-example-state";
const engineSha = "5c9b286fcb5761a3fcf4b4c87882ec56103333e7";
const prefix =
  "repo:example-org@900000004/switchyard@900000003:ref:refs/heads/main:job_workflow_ref:example-org/switchyard";

const contracts = Object.freeze({
  bootstrap: Object.freeze({
    audience: "api://switchyard-900000003/infrastructure/bootstrap-applier",
    credential: "github-infrastructure-apply-engine",
    identity: "id-switchyard-infra-bootstrap-uksouth",
    subject: `${prefix}/.github/workflows/infrastructure-apply-engine.yml@${engineSha}`,
  }),
  foundation: Object.freeze({
    audience: "api://switchyard-900000003/infrastructure/foundation-applier",
    credential: "github-infrastructure-apply-engine",
    identity: "id-switchyard-infra-foundation-uksouth",
    subject: `${prefix}/.github/workflows/infrastructure-apply-engine.yml@${engineSha}`,
  }),
  planner: Object.freeze({
    audience: "api://switchyard-900000003/infrastructure/planner",
    credential: "github-infrastructure-plan-engine",
    identity: "id-switchyard-infra-planner-uksouth",
    subject: `${prefix}/.github/workflows/infrastructure-plan-engine.yml@${engineSha}`,
  }),
});

const kind = process.argv[2];
if (!Object.hasOwn(contracts, kind)) fail();
const contract = contracts[kind];

const chunks = [];
let length = 0;
for await (const chunk of process.stdin) {
  length += chunk.length;
  if (length > MAX_INPUT_BYTES) fail();
  chunks.push(chunk);
}

let value;
try {
  value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  fail();
}
if (!isRecord(value) || !isRecord(value.properties)) fail();

const expectedId =
  `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
  `/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${contract.identity}` +
  `/federatedIdentityCredentials/${contract.credential}`;
if (
  typeof value.id !== "string" ||
  value.id.toLowerCase() !== expectedId.toLowerCase() ||
  value.name !== contract.credential ||
  value.type !== "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials" ||
  value.properties.issuer !== "https://token.actions.githubusercontent.com" ||
  value.properties.subject !== contract.subject ||
  !Array.isArray(value.properties.audiences) ||
  value.properties.audiences.length !== 1 ||
  value.properties.audiences[0] !== contract.audience
) {
  fail();
}

process.stdout.write("verified\n");

function isRecord(input) {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

function fail() {
  process.stderr.write(
    "The live federated credential does not match the reviewed OIDC subject correction.\n",
  );
  process.exit(1);
}
