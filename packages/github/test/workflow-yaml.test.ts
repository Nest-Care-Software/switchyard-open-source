import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyImmutableCallerWorkflow } from "../src/index.js";
import { ENABLED_MAPPING, REUSABLE_SHA, utf8, VALID_WORKFLOW } from "./fixtures.js";

describe("immutable GitHub workflow verification", () => {
  it("accepts the exact gate, pinned allocator call and future workload mapping", () => {
    assert.doesNotThrow(() => verifyImmutableCallerWorkflow(utf8(VALID_WORKFLOW), ENABLED_MAPPING));
  });

  it("rejects YAML aliases and duplicate keys instead of resolving them", () => {
    const alias = `${VALID_WORKFLOW}\nshared: &shared [one]\ncopy: *shared\n`;
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(alias), ENABLED_MAPPING),
      /workflow-yaml-alias-forbidden/,
    );

    const duplicate = VALID_WORKFLOW.replace(
      "    timeout-minutes: 25",
      "    timeout-minutes: 25\n    timeout-minutes: 25",
    );
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(duplicate), ENABLED_MAPPING),
      /workflow-yaml-invalid/,
    );
  });

  it("rejects unknown top-level and security-relevant job fields", () => {
    assert.throws(
      () =>
        verifyImmutableCallerWorkflow(utf8(`${VALID_WORKFLOW}\nmystery: true\n`), ENABLED_MAPPING),
      /workflow-contract-mismatch/,
    );

    const unknownJobField = VALID_WORKFLOW.replace(
      "    timeout-minutes: 25",
      "    timeout-minutes: 25\n    timeout: 99",
    );
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(unknownJobField), ENABLED_MAPPING),
      /workflow-contract-mismatch/,
    );
  });

  it("rejects mutable reusable refs and caller-supplied or expression timeouts", () => {
    const mutableRef = VALID_WORKFLOW.replace(REUSABLE_SHA, "main");
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(mutableRef), ENABLED_MAPPING),
      /reusable-workflow-reference-mismatch/,
    );

    for (const timeout of [`\${{ inputs.timeout }}`, '"25"']) {
      const workflow = VALID_WORKFLOW.replace("timeout-minutes: 25", `timeout-minutes: ${timeout}`);
      assert.throws(
        () => verifyImmutableCallerWorkflow(utf8(workflow), ENABLED_MAPPING),
        /workload-timeout-not-approved-literal/,
      );
    }

    const callerTimeout = VALID_WORKFLOW.replace(
      "      backupChoice: Keep going",
      "      backupChoice: Keep going\n      timeoutMinutes: 25",
    );
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(callerTimeout), ENABLED_MAPPING),
      /workflow-contract-mismatch/,
    );

    const wrongBackupChoice = VALID_WORKFLOW.replace(
      "backupChoice: Keep going",
      "backupChoice: Save money",
    );
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(wrongBackupChoice), ENABLED_MAPPING),
      /allocator-backup-choice-mismatch/,
    );
    const missingBackupChoice = VALID_WORKFLOW.replace("      backupChoice: Keep going\n", "");
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(missingBackupChoice), ENABLED_MAPPING),
      /workflow-contract-mismatch/,
    );
  });

  it("rejects profile expressions, gate bypasses and non-exact runner_label dependencies", () => {
    const profileExpression = VALID_WORKFLOW.replace(
      "profile: linux-x64-large",
      `profile: \${{ inputs.profile }}`,
    );
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(profileExpression), ENABLED_MAPPING),
      /workflow-contract-mismatch/,
    );

    const gateBypass = VALID_WORKFLOW.replace(
      "    needs: owner-approval\n    permissions:",
      "    needs: owner-approval\n    if: always()\n    permissions:",
    );
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(gateBypass), ENABLED_MAPPING),
      /workflow-contract-mismatch/,
    );

    const wrongOutput = VALID_WORKFLOW.replace("outputs.runner_label", "outputs.provider_label");
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(wrongOutput), ENABLED_MAPPING),
      /workload-runner-label-dependency-mismatch/,
    );
  });

  it("requires the allocator job to grant exactly id-token write", () => {
    const approvedPermissions = "    permissions:\n      id-token: write\n";
    for (const permissions of [
      "",
      "    permissions: read-all\n",
      "    permissions: write-all\n",
      "    permissions: null\n",
      "    permissions: [id-token]\n",
      "    permissions:\n      id-token: read\n",
      "    permissions:\n      id-token:\n        level: write\n",
      "    permissions:\n      id-token: write\n      contents: read\n",
      "    permissions:\n      id-token: write\n      checks: write\n",
    ]) {
      const workflow = VALID_WORKFLOW.replace(approvedPermissions, permissions);
      assert.throws(
        () => verifyImmutableCallerWorkflow(utf8(workflow), ENABLED_MAPPING),
        /allocator-permissions-not-approved/,
        permissions || "missing permissions",
      );
    }
  });

  it("requires unique literal workload and allocator display identities", () => {
    const duplicateWorkloadName = `  legacy-workload:
    name: Example approved build
    runs-on: ubuntu-24.04
    steps: []
`;
    assert.throws(
      () =>
        verifyImmutableCallerWorkflow(
          utf8(`${VALID_WORKFLOW}${duplicateWorkloadName}`),
          ENABLED_MAPPING,
        ),
      /workload-job-name-ambiguous/,
    );

    for (const extraJob of [
      `  duplicate-allocator-display:
    name: Allocate example runner
    runs-on: ubuntu-24.04
    steps: []
`,
      `  duplicate-allocator-check:
    name: Allocate example runner / allocate
    runs-on: ubuntu-24.04
    steps: []
`,
    ]) {
      assert.throws(
        () => verifyImmutableCallerWorkflow(utf8(`${VALID_WORKFLOW}${extraJob}`), ENABLED_MAPPING),
        /allocator-(job|check)-name-ambiguous/,
      );
    }

    for (const name of [`\${{ github.ref_name }}`, `Legacy \${{ matrix.version }}`, "[one, two]"]) {
      const dynamicName = `  dynamic-display:
    name: ${name}
    runs-on: ubuntu-24.04
    steps: []
`;
      assert.throws(
        () =>
          verifyImmutableCallerWorkflow(utf8(`${VALID_WORKFLOW}${dynamicName}`), ENABLED_MAPPING),
        /workflow-job-display-name-not-literal/,
        name,
      );
    }

    const distinctlyNamedLegacyJob = `  legacy-upgrade:
    name: Legacy example build
    runs-on: ubuntu-24.04
    steps: []
`;
    assert.doesNotThrow(() =>
      verifyImmutableCallerWorkflow(
        utf8(`${VALID_WORKFLOW}${distinctlyNamedLegacyJob}`),
        ENABLED_MAPPING,
      ),
    );
  });

  it("rejects missing dispatch and more than one consumer of one allocation label", () => {
    const missingDispatch = VALID_WORKFLOW.replace("  workflow_dispatch:\n", "");
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(missingDispatch), ENABLED_MAPPING),
      /workflow-dispatch-trigger-missing/,
    );

    const ambiguous = `${VALID_WORKFLOW}
  extra-consumer:
    name: Extra consumer
    needs: allocate-example-build
    runs-on: \${{ needs.allocate-example-build.outputs.runner_label }}
    timeout-minutes: 25
    steps:
      - run: echo unsafe
`;
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(ambiguous), ENABLED_MAPPING),
      /workload-runner-label-consumer-ambiguous/,
    );
  });

  it("rejects every strategy or matrix expansion on the mapped workload", () => {
    for (const strategy of [
      "    strategy:\n      matrix:\n        node: [22, 24]\n",
      "    strategy:\n      fail-fast: false\n",
    ]) {
      const workflow = VALID_WORKFLOW.replace(
        "    name: Example approved build\n",
        `    name: Example approved build\n${strategy}`,
      );
      assert.throws(
        () => verifyImmutableCallerWorkflow(utf8(workflow), ENABLED_MAPPING),
        /workload-strategy-forbidden/,
      );
    }
  });

  it("rejects dependency and output-reference variants outside the one approved consumer", () => {
    const variants = [
      `  extra-consumer:
    needs: [owner-approval, allocate-example-build]
    runs-on: ubuntu-latest
    steps: []
`,
      `  extra-consumer:
    runs-on: \${{needs.allocate-example-build.outputs.runner_label}}
    steps: []
`,
      `  extra-consumer:
    runs-on: \${{ needs['allocate-example-build']['outputs']['runner_label'] }}
    steps: []
`,
      `  extra-consumer:
    runs-on: ubuntu-latest
    env:
      LABEL: \${{ needs[format('{0}', 'allocate-example-build')].outputs.runner_label }}
    steps: []
`,
    ];

    for (const variant of variants) {
      assert.throws(
        () => verifyImmutableCallerWorkflow(utf8(`${VALID_WORKFLOW}${variant}`), ENABLED_MAPPING),
        /workload-runner-label-consumer-ambiguous/,
      );
    }

    const secondProperty = VALID_WORKFLOW.replace(
      "    timeout-minutes: 25",
      `    timeout-minutes: 25
    env:
      LABEL: \${{needs.allocate-example-build.outputs.runner_label}}`,
    );
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(secondProperty), ENABLED_MAPPING),
      /workload-runner-label-consumer-ambiguous/,
    );
  });

  it("rejects the centrally approved shared label only when another job selects it", () => {
    const extraJob = `  unrelated-managed-label-consumer:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    steps: []
`;
    assert.throws(
      () => verifyImmutableCallerWorkflow(utf8(`${VALID_WORKFLOW}${extraJob}`), ENABLED_MAPPING),
      /managed-label-consumer-ambiguous/,
    );

    const harmlessMention = `  unrelated-managed-label-documentation:
    runs-on: ubuntu-24.04
    env:
      EXAMPLE_LABEL: blacksmith-4vcpu-ubuntu-2404
    steps:
      - run: echo blacksmith-4vcpu-ubuntu-2404
`;
    assert.doesNotThrow(() =>
      verifyImmutableCallerWorkflow(utf8(`${VALID_WORKFLOW}${harmlessMention}`), ENABLED_MAPPING),
    );
  });

  it("matches managed runner labels with GitHub's ASCII case-insensitive semantics", () => {
    for (const label of ["BLACKSMITH-4VCPU-UBUNTU-2404", "BlackSmith-4vCPU-Ubuntu-2404"]) {
      const scalar = `  unrelated-managed-label-case:
    runs-on: ${label}
    steps: []
`;
      assert.throws(
        () => verifyImmutableCallerWorkflow(utf8(`${VALID_WORKFLOW}${scalar}`), ENABLED_MAPPING),
        /managed-label-consumer-ambiguous/,
        label,
      );
    }

    for (const labels of [
      ["BLACKSMITH-4VCPU-UBUNTU-2404", "linux", "x64"],
      ["self-hosted", "BlackSmith-4vCPU-Ubuntu-2404", "x64"],
      ["self-hosted", "linux", "BLACKSMITH-4VCPU-UBUNTU-2404"],
    ]) {
      const array = `  unrelated-managed-label-array-case:
    runs-on: [${labels.join(", ")}]
    steps: []
`;
      assert.throws(
        () => verifyImmutableCallerWorkflow(utf8(`${VALID_WORKFLOW}${array}`), ENABLED_MAPPING),
        /managed-label-consumer-ambiguous/,
        labels.join(","),
      );
    }
  });

  it("rejects every expression form in an unrelated runs-on value", () => {
    const expressions = [
      `\${{ format('{0}', 'ubuntu-24.04') }}`,
      `\${{ join(fromJSON('["ubuntu-24.04"]'), '') }}`,
      `\${{ env.RUNNER_LABEL }}`,
      `\${{ vars.RUNNER_LABEL }}`,
      `ubuntu-\${{ github.ref_name }}`,
    ];
    for (const expression of expressions) {
      const extraJob = `  unrelated-expression:
    runs-on: ${expression}
    steps: []
`;
      assert.throws(
        () => verifyImmutableCallerWorkflow(utf8(`${VALID_WORKFLOW}${extraJob}`), ENABLED_MAPPING),
        /unmapped-job-runs-on-not-approved-literal/,
        expression,
      );
    }

    const expressionArray = `  unrelated-expression-array:
    runs-on:
      - self-hosted
      - \${{ vars.RUNNER_LABEL }}
    steps: []
`;
    assert.throws(
      () =>
        verifyImmutableCallerWorkflow(utf8(`${VALID_WORKFLOW}${expressionArray}`), ENABLED_MAPPING),
      /unmapped-job-runs-on-not-approved-literal/,
    );
  });

  it("accepts absent, scalar and array literal runs-on shapes for unrelated jobs", () => {
    const approvedLiterals = `  unrelated-literal:
    runs-on: ubuntu-24.04
    steps: []
  unrelated-literal-array:
    runs-on: [self-hosted, linux, x64]
    steps: []
  unrelated-reusable:
    uses: example-org/switchyard/.github/workflows/example.yml@${REUSABLE_SHA}
`;
    assert.doesNotThrow(() =>
      verifyImmutableCallerWorkflow(utf8(`${VALID_WORKFLOW}${approvedLiterals}`), ENABLED_MAPPING),
    );
  });
});
