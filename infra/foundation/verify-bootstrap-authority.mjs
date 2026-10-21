import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const subscriptionId = "a0000000-0000-4000-8000-000000000001";
const subscriptionScope = `/subscriptions/${subscriptionId}`;
const bootstrapIdentityResourceId = `${subscriptionScope}/resourceGroups/rg-switchyard-example-state/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-switchyard-infra-bootstrap-uksouth`;
const bootstrapIdentityName = "id-switchyard-infra-bootstrap-uksouth";
const bootstrapIdentityResourceGroup = "rg-switchyard-example-state";
const tenantId = "a0000000-0000-4000-8000-000000000002";
const roleDefinitionSeed = "switchyard-initial-control-creator";
const roleDefinitionName = armGuid(subscriptionScope, roleDefinitionSeed);
const expectedRoleDefinitionId = `${subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionName}`;
const foundationTemplate = JSON.parse(readFileSync(new URL("main.json", import.meta.url), "utf8"));
const expectedRole = foundationTemplate.resources.find(
  (resource) =>
    resource.type === "Microsoft.Authorization/roleDefinitions" &&
    resource.properties?.roleName === "Switchyard initial control creator",
);
if (!expectedRole) throw new Error("reviewed-foundation-role-missing");

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "role-definition-id" && args.length === 0) {
    process.stdout.write(`${expectedRoleDefinitionId}\n`);
  } else if (command === "assignment-name" && args.length === 4) {
    const [principalId, roleDefinitionId, planDigest, controlTemplateDigest] = args;
    validateIdentityArguments(principalId, roleDefinitionId);
    validateDigests(planDigest, controlTemplateDigest);
    process.stdout.write(
      `${armGuid(subscriptionScope, bootstrapIdentityResourceId, roleDefinitionId, planDigest, controlTemplateDigest)}\n`,
    );
  } else if (command === "foundation" && args.length === 0) {
    const outputs = await readJsonInput();
    const activated = outputValue(outputs, "activated", "Bool");
    const principalId = outputValue(outputs, "bootstrapIdentityPrincipalId", "String");
    const clientId = outputValue(outputs, "bootstrapIdentityClientId", "String");
    const roleDefinitionId = outputValue(
      outputs,
      "initialControlCreatorRoleDefinitionId",
      "String",
    );
    if (activated !== true) throw new Error("foundation-not-activated");
    if (!uuidPattern.test(principalId) || !uuidPattern.test(clientId)) {
      throw new Error("foundation-bootstrap-identity-invalid");
    }
    if (normaliseResourceId(roleDefinitionId) !== normaliseResourceId(expectedRoleDefinitionId)) {
      throw new Error("foundation-initial-role-id-mismatch");
    }
    process.stdout.write(`${clientId}\t${principalId}\t${expectedRoleDefinitionId}\n`);
  } else if (command === "identity-evidence" && args.length === 2) {
    const [clientId, principalId] = args;
    if (!uuidPattern.test(clientId) || !uuidPattern.test(principalId)) {
      throw new Error("bootstrap-identity-argument-invalid");
    }
    verifyIdentity(await readJsonInput(), clientId, principalId);
    process.stdout.write("verified\n");
  } else if (command === "role-definition-evidence" && args.length === 0) {
    verifyRoleDefinition(await readJsonInput());
    process.stdout.write("verified\n");
  } else if (command === "grant-outputs" && args.length === 5) {
    const [assignmentId, principalId, roleDefinitionId, planDigest, controlTemplateDigest] = args;
    validateIdentityArguments(principalId, roleDefinitionId);
    validateDigests(planDigest, controlTemplateDigest);
    const outputs = await readJsonInput();
    const expectedName = assignmentId.split("/").at(-1);
    const expected = {
      activated: true,
      assignmentId,
      assignmentName: expectedName,
      bootstrapPrincipalId: principalId,
      roleDefinitionId,
      reviewedPlanDigest: planDigest,
      controlTemplateDigest,
    };
    for (const [name, value] of Object.entries(expected)) {
      const type = typeof value === "boolean" ? "Bool" : "String";
      const observed = outputValue(outputs, name, type);
      if (
        name.endsWith("Id")
          ? normaliseResourceId(observed) !== normaliseResourceId(value)
          : observed !== value
      ) {
        throw new Error(`grant-output-${name}-mismatch`);
      }
    }
  } else if (command === "assignment-list" && args.length === 5) {
    const [assignmentId, principalId, roleDefinitionId, planDigest, controlTemplateDigest] = args;
    validateIdentityArguments(principalId, roleDefinitionId);
    validateDigests(planDigest, controlTemplateDigest);
    const assignments = await readJsonInput();
    if (!Array.isArray(assignments)) throw new Error("assignment-list-not-array");
    const matches = assignments.filter(
      (assignment) =>
        normaliseResourceId(requiredString(assignment, "id")) === normaliseResourceId(assignmentId),
    );
    const expectedDescription = assignmentDescription(planDigest, controlTemplateDigest);
    const otherDigestBindings = assignments.filter(
      (assignment) =>
        assignment?.description === expectedDescription &&
        normaliseResourceId(requiredString(assignment, "id")) !== normaliseResourceId(assignmentId),
    );
    if (otherDigestBindings.length > 0) throw new Error("assignment-digest-binding-mismatch");
    if (matches.length === 0) {
      process.stdout.write("absent\n");
    } else {
      if (matches.length !== 1) throw new Error("assignment-list-ambiguous");
      verifyAssignment(
        matches[0],
        assignmentId,
        principalId,
        roleDefinitionId,
        planDigest,
        controlTemplateDigest,
      );
      process.stdout.write("present\n");
    }
  } else {
    throw new Error("invalid-command");
  }
} catch (error) {
  process.stderr.write(`Bootstrap authority evidence rejected: ${error.message}\n`);
  process.exitCode = 1;
}

function verifyAssignment(
  assignment,
  assignmentId,
  principalId,
  roleDefinitionId,
  planDigest,
  controlTemplateDigest,
) {
  const expectedName = assignmentId.split("/").at(-1);
  const expectedDescription = assignmentDescription(planDigest, controlTemplateDigest);
  if (requiredString(assignment, "name") !== expectedName)
    throw new Error("assignment-name-mismatch");
  if (normaliseResourceId(requiredString(assignment, "scope")) !== subscriptionScope) {
    throw new Error("assignment-scope-mismatch");
  }
  if (requiredString(assignment, "principalId") !== principalId) {
    throw new Error("assignment-principal-mismatch");
  }
  if (assignment.principalType !== "ServicePrincipal") {
    throw new Error("assignment-principal-type-mismatch");
  }
  if (
    normaliseResourceId(requiredString(assignment, "roleDefinitionId")) !==
    normaliseResourceId(roleDefinitionId)
  ) {
    throw new Error("assignment-role-mismatch");
  }
  if (assignment.description !== expectedDescription) {
    throw new Error("assignment-description-mismatch");
  }
  if (assignment.condition != null || assignment.delegatedManagedIdentityResourceId != null) {
    throw new Error("assignment-unreviewed-condition-or-delegation");
  }
}

function verifyIdentity(identity, clientId, principalId) {
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("bootstrap-identity-evidence-invalid");
  }
  const expected = {
    clientId,
    id: bootstrapIdentityResourceId,
    location: "uksouth",
    name: bootstrapIdentityName,
    principalId,
    resourceGroup: bootstrapIdentityResourceGroup,
    tenantId,
    type: "Microsoft.ManagedIdentity/userAssignedIdentities",
  };
  for (const [name, value] of Object.entries(expected)) {
    const observed = requiredString(identity, name);
    if (
      name === "id"
        ? normaliseResourceId(observed) !== normaliseResourceId(value)
        : observed !== value
    ) {
      throw new Error(`bootstrap-identity-${name}-mismatch`);
    }
  }
}

function verifyRoleDefinition(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("initial-role-definition-evidence-invalid");
  }
  const role = value;
  if (
    normaliseResourceId(requiredString(role, "id")) !==
    normaliseResourceId(expectedRoleDefinitionId)
  ) {
    throw new Error("initial-role-definition-id-mismatch");
  }
  if (requiredString(role, "name") !== roleDefinitionName) {
    throw new Error("initial-role-definition-name-mismatch");
  }
  if (role.roleName !== expectedRole.properties.roleName || role.roleType !== "CustomRole") {
    throw new Error("initial-role-definition-kind-mismatch");
  }
  if (role.description !== expectedRole.properties.description) {
    throw new Error("initial-role-definition-description-mismatch");
  }
  assertExactStringSet(role.assignableScopes, [subscriptionScope], "assignable-scopes");
  if (!Array.isArray(role.permissions) || role.permissions.length !== 1) {
    throw new Error("initial-role-definition-permissions-invalid");
  }
  const permission = role.permissions[0];
  assertExactStringSet(
    permission.actions,
    expectedRole.properties.permissions[0].actions,
    "actions",
  );
  for (const name of ["dataActions", "notActions", "notDataActions"]) {
    assertExactStringSet(permission[name], [], name);
  }
}

function assertExactStringSet(observed, expected, name) {
  if (
    !Array.isArray(observed) ||
    observed.some((value) => typeof value !== "string") ||
    new Set(observed).size !== observed.length ||
    [...observed].sort().join("\n") !== [...expected].sort().join("\n")
  ) {
    throw new Error(`initial-role-definition-${name}-mismatch`);
  }
}

function assignmentDescription(planDigest, controlTemplateDigest) {
  return `Temporary Switchyard initial control authority for plan ${planDigest} and control template ${controlTemplateDigest}.`;
}

function validateIdentityArguments(principalId, roleDefinitionId) {
  if (!uuidPattern.test(principalId)) throw new Error("bootstrap-principal-invalid");
  if (normaliseResourceId(roleDefinitionId) !== normaliseResourceId(expectedRoleDefinitionId)) {
    throw new Error("initial-role-id-mismatch");
  }
}

function validateDigests(planDigest, controlTemplateDigest) {
  if (!digestPattern.test(planDigest)) throw new Error("plan-digest-invalid");
  if (!digestPattern.test(controlTemplateDigest))
    throw new Error("control-template-digest-invalid");
}

function outputValue(outputs, name, expectedType) {
  if (outputs === null || typeof outputs !== "object" || Array.isArray(outputs)) {
    throw new Error("deployment-outputs-not-object");
  }
  const entry = outputs[name];
  if (
    entry === null ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    entry.type !== expectedType ||
    !("value" in entry)
  ) {
    throw new Error(`deployment-output-${name}-invalid`);
  }
  return entry.value;
}

function requiredString(value, name) {
  if (value === null || typeof value !== "object" || typeof value[name] !== "string") {
    throw new Error(`assignment-${name}-invalid`);
  }
  return value[name];
}

function normaliseResourceId(value) {
  if (typeof value !== "string") throw new Error("resource-id-invalid");
  return value.toLowerCase();
}

async function readJsonInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0 || raw.length > 1024 * 1024) throw new Error("json-input-size-invalid");
  return JSON.parse(raw);
}

function armGuid(...values) {
  const namespace = uuidBytes("11fb06fb-712d-4ddd-98c7-e71bbd588830");
  const name = Buffer.from(values.join("-"), "utf8");
  const hash = createHash("sha1").update(namespace).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidBytes(value) {
  if (!uuidPattern.test(value)) throw new Error("namespace-uuid-invalid");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}
