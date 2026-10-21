import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const wrapperPath = "infra/foundation/manage-bootstrap-authority.sh";
const verifierPath = "infra/foundation/verify-bootstrap-authority.mjs";
const template = JSON.parse(readFileSync("infra/foundation/bootstrap-authority.json", "utf8"));
const foundationTemplate = JSON.parse(readFileSync("infra/foundation/main.json", "utf8"));
const subscriptionId = "a0000000-0000-4000-8000-000000000001";
const tenantId = "a0000000-0000-4000-8000-000000000002";
const subscriptionScope = `/subscriptions/${subscriptionId}`;
const principalId = "11111111-1111-4111-8111-111111111111";
const clientId = "22222222-2222-4222-8222-222222222222";
const cloudShellAzureCliVersionOutput = readFileSync(
  "scripts/fixtures/azure-cli-2.89.1-cloud-shell.txt",
  "utf8",
);
const planDigest = "a".repeat(64);
const controlTemplateDigest = "b".repeat(64);
const roleDefinitionId = runVerifier(["role-definition-id"]).stdout.trim();
const assignmentName = runVerifier([
  "assignment-name",
  principalId,
  roleDefinitionId,
  planDigest,
  controlTemplateDigest,
]).stdout.trim();
const assignmentId = `${subscriptionScope}/providers/Microsoft.Authorization/roleAssignments/${assignmentName}`;
const foundationRole = foundationTemplate.resources.find(
  (resource) => resource.properties?.roleName === "Switchyard initial control creator",
);

describe("digest-bound bootstrap authority template", () => {
  it("contains exactly one conditional assignment to the fixed bootstrap identity and role", () => {
    assert.deepEqual(Object.keys(template.parameters).sort(), [
      "controlTemplateDigest",
      "reviewedPlanDigest",
    ]);
    for (const parameter of Object.values(template.parameters)) {
      assert.equal(parameter.minLength, 64);
      assert.equal(parameter.maxLength, 64);
    }
    assert.equal(template.variables.expectedSubscriptionId, subscriptionId);
    assert.equal(template.variables.expectedTenantId, tenantId);
    assert.match(template.variables.activationAllowed, /subscription\(\)\.subscriptionId/);
    assert.match(template.variables.activationAllowed, /tenant\(\)\.tenantId/);
    assert.match(template.variables.activationAllowed, /reviewedPlanDigestWithoutHex/);
    assert.match(template.variables.activationAllowed, /controlTemplateDigestWithoutHex/);
    assert.equal(template.resources.length, 1);
    const assignment = template.resources[0];
    assert.equal(assignment.type, "Microsoft.Authorization/roleAssignments");
    assert.equal(assignment.condition, "[variables('activationAllowed')]");
    assert.equal(assignment.name, "[variables('assignmentName')]");
    assert.match(template.variables.assignmentName, /reviewedPlanDigest/);
    assert.match(template.variables.assignmentName, /controlTemplateDigest/);
    assert.equal(template.variables.bootstrapIdentityName, "id-switchyard-infra-bootstrap-uksouth");
    assert.match(template.variables.assignmentName, /bootstrapIdentityName/);
    assert.match(template.variables.assignmentName, /initialControlCreatorRoleDefinitionName/);
    assert.match(assignment.properties.principalId, /bootstrapIdentityName/);
    assert.equal(assignment.properties.principalType, "ServicePrincipal");
    assert.match(assignment.properties.roleDefinitionId, /initialControlCreatorRoleDefinitionName/);
    assert.match(assignment.properties.description, /assignmentDescription/);
    assert.equal(template.outputs.activated.value, "[variables('activationAllowed')]");
  });

  it("uses Microsoft's deterministic ARM guid contract for the exact identities and both digests", () => {
    assert.equal(
      roleDefinitionId,
      `${subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions/3ad77f1d-46f0-5203-b2d8-2ccfa0bcf5e3`,
    );
    assert.equal(assignmentName, "18069aee-ef40-59c3-8268-0ad4c22db8af");
  });

  it("is unreachable from all checked-in GitHub workflow shells", () => {
    const workflowSource = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name) => readFileSync(`.github/workflows/${name}`, "utf8"))
      .join("\n");
    assert.doesNotMatch(
      workflowSource,
      /manage-bootstrap-authority|bootstrap-authority\.json|Switchyard initial control creator/,
    );
  });
});

describe("owner-run bootstrap authority wrapper", () => {
  it("pins Cloud Shell Azure CLI 2.89.1 and contains no login or infrastructure engine", () => {
    const wrapper = readFileSync(wrapperPath, "utf8");
    const versionParser = readFileSync("infra/foundation/azure-cli-version.sh", "utf8");
    assert.match(wrapper, /expected_azure_cli_version='2\.89\.1'/);
    assert.match(wrapper, /source "\$\{script_dir\}\/azure-cli-version\.sh"/);
    assert.match(versionParser, /az --version 2>&1/);
    assert.match(wrapper, new RegExp(subscriptionId));
    assert.match(wrapper, new RegExp(tenantId));
    assert.match(wrapper, /GRANT SWITCHYARD INITIAL CONTROL AUTHORITY PLAN/);
    assert.match(wrapper, /az deployment sub show/);
    assert.match(wrapper, /az identity show/);
    assert.match(wrapper, /az role definition show/);
    assert.match(wrapper, /az role assignment delete/);
    assert.doesNotMatch(
      wrapper,
      /\baz\s+login\b|\b(?:tofu|terraform)\s+(?:plan|apply|destroy)\b|github|gh api/,
    );
  });

  it("accepts the owner's complete multiline Cloud Shell output captured from stderr", () => {
    withFakeAzure({}, ({ bin, log }) => {
      const result = runWrapper(bin, grantArguments());
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(log, "utf8"), /^--version\naccount show/m);
    });
  });

  it("ignores unrelated azure-cli substring occurrences after the exact version candidate", () => {
    const cliOutput = `${cloudShellAzureCliVersionOutput}notice: azure-cli is installed\n/usr/share/azure-cli-extensions/cache\n`;
    withFakeAzure({ cliOutput }, ({ bin }) => {
      const result = runWrapper(bin, grantArguments());
      assert.equal(result.status, 0, result.stderr);
    });
  });

  it("rejects missing, duplicate, malformed, warning-only, token-padded and wrong CLI versions", () => {
    const rejectedOutputs = [
      ["empty", ""],
      ["missing", "core 2.89.1\nPython (Linux) 3.12.9\n"],
      ["duplicate", "azure-cli 2.89.1\nazure-cli 2.89.1\ncore 2.89.1\n"],
      ["malformed", "azure-cli version 2.89.1\ncore 2.89.1\n"],
      ["malformed-alongside-valid", "azure-cli 2.89.1\nazure-cli version 2.89.1\ncore 2.89.1\n"],
      ["warning-only", "WARNING: Azure CLI version lookup is unavailable\n"],
      ["leading-token", "warning azure-cli 2.89.1\n"],
      ["trailing-token", "azure-cli 2.89.1 extra\n"],
      ["different", "azure-cli 2.89.0\ncore 2.89.0\n"],
    ];
    for (const [name, cliOutput] of rejectedOutputs) {
      withFakeAzure({ cliOutput }, ({ bin, log }) => {
        const result = runWrapper(bin, grantArguments());
        assert.notEqual(result.status, 0, name);
        assert.match(result.stderr, /Azure CLI 2\.89\.1 is required/);
        assert.equal(readFileSync(log, "utf8"), "--version\n");
      });
    }
  });

  it("rejects bad digests and acknowledgement before any Azure call", () => {
    withFakeAzure({}, ({ bin, log }) => {
      for (const args of [
        ["grant", "A".repeat(64), controlTemplateDigest, acknowledgement()],
        ["grant", planDigest.slice(1), controlTemplateDigest, acknowledgement()],
        ["grant", planDigest, "g".repeat(64), acknowledgement()],
        ["grant", planDigest, controlTemplateDigest, "GRANT SOMETHING ELSE"],
      ]) {
        const result = runWrapper(bin, args);
        assert.notEqual(result.status, 0, args.join(" "));
      }
      assert.equal(readOptional(log), "");
    });
  });

  it("rejects the wrong subscription or tenant before foundation readback", () => {
    for (const options of [
      { subscriptionId: "33333333-3333-4333-8333-333333333333" },
      { tenantId: "44444444-4444-4444-8444-444444444444" },
    ]) {
      withFakeAzure(options, ({ bin, log }) => {
        const result = runWrapper(bin, grantArguments());
        assert.notEqual(result.status, 0, JSON.stringify(options));
        assert.equal(readOptional(log).includes("deployment sub show"), false);
      });
    }
  });

  it("rejects a changed foundation principal or role identity", () => {
    for (const options of [{ foundationPrincipal: "wrong" }, { foundationRole: "wrong" }]) {
      withFakeAzure(options, ({ bin }) => {
        const result = runWrapper(bin, grantArguments());
        assert.notEqual(result.status, 0, JSON.stringify(options));
        assert.match(result.stderr, /evidence rejected|mismatch/i);
      });
    }
  });

  it("rejects a changed live bootstrap identity or creator role definition", () => {
    for (const options of [{ identityPrincipal: "wrong" }, { changedRoleDefinition: true }]) {
      withFakeAzure(options, ({ bin, log }) => {
        const result = runWrapper(bin, grantArguments());
        assert.notEqual(result.status, 0, JSON.stringify(options));
        assert.equal(readFileSync(log, "utf8").includes("role assignment create"), false);
      });
    }
  });

  it("grants idempotently and proves the same exact assignment after repeated grants", () => {
    withFakeAzure({}, ({ bin, log }) => {
      const first = runWrapper(bin, grantArguments());
      const second = runWrapper(bin, grantArguments());
      assert.equal(first.status, 0, first.stderr);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /assignment is present/);
      const calls = readFileSync(log, "utf8");
      assert.equal((calls.match(/role assignment create/g) ?? []).length, 2);
      assert.equal(calls.includes("deployment sub create"), false);
      assert.equal(calls.includes("role assignment delete"), false);
      assert.match(calls, new RegExp(assignmentName));
      assert.match(calls, new RegExp(`--assignee-object-id ${principalId}`));
      assert.match(calls, new RegExp(`--role ${escapeRegex(roleDefinitionId)}`));
      const roleListCalls = calls
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("role assignment list "));
      assert.ok(roleListCalls.length > 0);
      assert.ok(
        roleListCalls.every(
          (line) =>
            line ===
            `role assignment list --scope ${subscriptionScope} --fill-principal-name false --fill-role-definition-name false --subscription ${subscriptionId} --output json --only-show-errors`,
        ),
      );
    });
  });

  it("omits both forms of include-inherited while preserving exact scope and fill arguments", () => {
    const wrapper = readFileSync(wrapperPath, "utf8");
    assert.equal(wrapper.includes("--include-inherited"), false);
    assert.match(wrapper, /--scope "\$\{subscription_scope\}"/);
    assert.match(wrapper, /--fill-principal-name false/);
    assert.match(wrapper, /--fill-role-definition-name false/);
  });

  it("fails closed when assignment presence or assignment evidence is missing or changed", () => {
    for (const scenario of ["missing-after-grant", "changed-after-grant"]) {
      withFakeAzure({ scenario }, ({ bin }) => {
        const result = runWrapper(bin, grantArguments());
        assert.notEqual(result.status, 0, scenario);
      });
    }
  });

  it("revokes after a successful or uncertain grant and proves absence", () => {
    for (const scenario of ["normal", "unknown-grant-result"]) {
      withFakeAzure({ scenario }, ({ bin, log }) => {
        const grant = runWrapper(bin, grantArguments());
        if (scenario === "normal") assert.equal(grant.status, 0, grant.stderr);
        else assert.notEqual(grant.status, 0);
        const revoke = runWrapper(bin, ["revoke", planDigest, controlTemplateDigest]);
        assert.equal(revoke.status, 0, revoke.stderr);
        assert.match(revoke.stdout, /assignment is absent/);
        assert.match(
          readFileSync(log, "utf8"),
          new RegExp(`role assignment delete --ids ${escapeRegex(assignmentId)}`),
        );
      });
    }
  });

  it("makes revoke idempotent and keeps verify-absent non-mutating", () => {
    withFakeAzure({}, ({ bin, log }) => {
      const first = runWrapper(bin, ["revoke", planDigest, controlTemplateDigest]);
      const second = runWrapper(bin, ["revoke", planDigest, controlTemplateDigest]);
      const verify = runWrapper(bin, ["verify-absent", planDigest, controlTemplateDigest]);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(verify.status, 0, verify.stderr);
      assert.equal(readFileSync(log, "utf8").includes("role assignment delete"), false);
    });

    withFakeAzure({ initialState: "present" }, ({ bin, log }) => {
      const verify = runWrapper(bin, ["verify-absent", planDigest, controlTemplateDigest]);
      assert.notEqual(verify.status, 0);
      assert.equal(readFileSync(log, "utf8").includes("role assignment delete"), false);
    });
  });

  it("does not delete changed evidence and reports delete or final absence failures", () => {
    withFakeAzure({ initialState: "changed" }, ({ bin, log }) => {
      const result = runWrapper(bin, ["revoke", planDigest, controlTemplateDigest]);
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(log, "utf8").includes("role assignment delete"), false);
    });
    withFakeAzure({ initialState: "present", scenario: "delete-fails" }, ({ bin }) => {
      const result = runWrapper(bin, ["revoke", planDigest, controlTemplateDigest]);
      assert.notEqual(result.status, 0);
    });
    withFakeAzure({ initialState: "present", scenario: "delete-leaves-assignment" }, ({ bin }) => {
      const result = runWrapper(bin, ["revoke", planDigest, controlTemplateDigest]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /still present/);
    });
  });
});

function grantArguments() {
  return ["grant", planDigest, controlTemplateDigest, acknowledgement()];
}

function acknowledgement() {
  return `GRANT SWITCHYARD INITIAL CONTROL AUTHORITY PLAN ${planDigest} CONTROL TEMPLATE ${controlTemplateDigest}`;
}

function runWrapper(fakeBin, args) {
  return spawnSync("bash", [wrapperPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
  });
}

function runVerifier(args, input = "") {
  return spawnSync("node", [verifierPath, ...args], { encoding: "utf8", input });
}

function withFakeAzure(options, work) {
  const directory = mkdtempSync(join(tmpdir(), "switchyard-bootstrap-authority-test-"));
  const bin = join(directory, "bin");
  const log = join(directory, "az.log");
  const state = join(directory, "assignment.state");
  const scenario = options.scenario ?? "normal";
  const observedSubscriptionId = options.subscriptionId ?? subscriptionId;
  const observedTenantId = options.tenantId ?? tenantId;
  const observedCliOutput = options.cliOutput ?? cloudShellAzureCliVersionOutput;
  const foundationPrincipal =
    options.foundationPrincipal === "wrong" ? "55555555-5555-4555-8555-555555555555" : principalId;
  const foundationRoleId =
    options.foundationRole === "wrong"
      ? `${subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions/66666666-6666-4666-8666-666666666666`
      : roleDefinitionId;
  const foundationOutputs = deploymentOutputs({
    activated: true,
    bootstrapIdentityClientId: clientId,
    bootstrapIdentityPrincipalId: foundationPrincipal,
    initialControlCreatorRoleDefinitionId: foundationRoleId,
  });
  const presentAssignment = assignmentEvidence({});
  const changedAssignment = assignmentEvidence({
    principalId: "88888888-8888-4888-8888-888888888888",
  });
  const identityEvidence = {
    clientId,
    id: `${subscriptionScope}/resourceGroups/rg-switchyard-example-state/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-switchyard-infra-bootstrap-uksouth`,
    location: "uksouth",
    name: "id-switchyard-infra-bootstrap-uksouth",
    principalId:
      options.identityPrincipal === "wrong" ? "99999999-9999-4999-8999-999999999999" : principalId,
    resourceGroup: "rg-switchyard-example-state",
    tenantId,
    type: "Microsoft.ManagedIdentity/userAssignedIdentities",
  };
  const roleEvidence = {
    assignableScopes: [subscriptionScope],
    description: foundationRole.properties.description,
    id: roleDefinitionId,
    name: roleDefinitionId.split("/").at(-1),
    permissions: [
      {
        actions: options.changedRoleDefinition
          ? [
              ...foundationRole.properties.permissions[0].actions,
              "Microsoft.Compute/virtualMachines/write",
            ]
          : foundationRole.properties.permissions[0].actions,
        dataActions: [],
        notActions: [],
        notDataActions: [],
      },
    ],
    roleName: foundationRole.properties.roleName,
    roleType: "CustomRole",
  };

  try {
    mkdirSync(bin);
    writeFileSync(state, options.initialState ?? "absent");
    const az = join(bin, "az");
    writeFileSync(
      az,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${shellQuote(log)}
case "$1" in
  --version)
    printf '%s' ${shellQuote(observedCliOutput)} >&2
    ;;
  account)
    [[ "$2" == 'show' ]] || exit 64
    printf '%s\\n' ${shellQuote(JSON.stringify({ id: observedSubscriptionId, tenantId: observedTenantId }))}
    ;;
  identity)
    [[ "$2" == 'show' ]] || exit 64
    printf '%s\\n' ${shellQuote(JSON.stringify(identityEvidence))}
    ;;
  deployment)
    [[ "$2" == 'sub' ]] || exit 64
    if [[ "$3" == 'show' ]]; then
      printf '%s\\n' ${shellQuote(foundationOutputs)}
    else
      exit 64
    fi
    ;;
  role)
    if [[ "$2" == 'definition' && "$3" == 'show' ]]; then
      printf '%s\\n' ${shellQuote(JSON.stringify(roleEvidence))}
    elif [[ "$2" == 'assignment' && "$3" == 'list' ]]; then
      current="$(< ${shellQuote(state)})"
      if [[ "$current" == 'present' ]]; then
        printf '%s\\n' ${shellQuote(JSON.stringify([presentAssignment]))}
      elif [[ "$current" == 'changed' ]]; then
        printf '%s\\n' ${shellQuote(JSON.stringify([changedAssignment]))}
      else
        printf '[]\\n'
      fi
    elif [[ "$2" == 'assignment' && "$3" == 'create' ]]; then
      if [[ ${shellQuote(scenario)} == 'unknown-grant-result' ]]; then
        printf 'present' > ${shellQuote(state)}
        exit 9
      fi
      if [[ ${shellQuote(scenario)} == 'missing-after-grant' ]]; then
        printf 'absent' > ${shellQuote(state)}
      elif [[ ${shellQuote(scenario)} == 'changed-after-grant' ]]; then
        printf 'changed' > ${shellQuote(state)}
      else
        printf 'present' > ${shellQuote(state)}
      fi
    elif [[ "$2" == 'assignment' && "$3" == 'delete' ]]; then
      [[ "$*" == *${shellQuote(`--ids ${assignmentId}`)}* ]] || exit 65
      [[ ${shellQuote(scenario)} != 'delete-fails' ]] || exit 8
      if [[ ${shellQuote(scenario)} != 'delete-leaves-assignment' ]]; then
        printf 'absent' > ${shellQuote(state)}
      fi
    else
      exit 64
    fi
    ;;
  *)
    exit 64
    ;;
esac
`,
    );
    chmodSync(az, 0o755);
    work({ bin, log, state });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function deploymentOutputs(values) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        { type: typeof value === "boolean" ? "Bool" : "String", value },
      ]),
    ),
  );
}

function assignmentEvidence(overrides) {
  return {
    condition: null,
    delegatedManagedIdentityResourceId: null,
    description: `Temporary Switchyard initial control authority for plan ${planDigest} and control template ${controlTemplateDigest}.`,
    id: assignmentId,
    name: assignmentName,
    principalId,
    principalType: "ServicePrincipal",
    roleDefinitionId,
    scope: subscriptionScope,
    ...overrides,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
