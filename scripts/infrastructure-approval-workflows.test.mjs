import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { isAlias, parseDocument, visit } from "yaml";

const finalEngineSha = "5c9b286fcb5761a3fcf4b4c87882ec56103333e7";
const planEnginePath = ".github/workflows/infrastructure-plan-engine.yml";
const applyEnginePath = ".github/workflows/infrastructure-apply-engine.yml";
const planDispatcherPath = ".github/workflows/infrastructure-plan.yml";
const applyDispatcherPath = ".github/workflows/infrastructure-apply.yml";
const initialStateDispatcherPath = ".github/workflows/infrastructure-initialise-state.yml";
const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const setupNode = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const uploadArtifact = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const expression = (value) => `$${`{{ ${value} }}`}`;

const planInputs = {
  authority_class: {
    description: "Exact reviewed authority class, foundation or bootstrap",
    required: true,
    type: "string",
  },
  commit_sha: {
    description: "Exact lowercase commit SHA currently at main",
    required: true,
    type: "string",
  },
};
const applyInputs = {
  artifact_id: {
    description: "Exact immutable GitHub plan artifact ID",
    required: true,
    type: "string",
  },
  commit_sha: {
    description: "Exact lowercase commit SHA currently at main",
    required: true,
    type: "string",
  },
  destructive_acknowledgement: {
    description: "Exact digest-bound acknowledgement when the plan is destructive",
    required: true,
    type: "string",
  },
  plan_digest: {
    description: "Full lowercase SHA-256 digest of the opaque saved plan",
    required: true,
    type: "string",
  },
  plan_run_id: {
    description: "Exact first-attempt plan workflow run ID",
    required: true,
    type: "string",
  },
};
const applyDispatcherInputs = {
  ...applyInputs,
  destructive_acknowledgement: {
    description: "Exact digest-bound acknowledgement when destructive; otherwise leave blank",
    required: false,
    default: "",
    type: "string",
  },
};
const initialStateInputs = {
  commit_sha: {
    description: "Exact lowercase commit SHA currently at main",
    required: true,
    type: "string",
  },
  acknowledgement: {
    description: "Type INITIALISE EMPTY SWITCHYARD STATE",
    required: true,
    type: "string",
  },
};

const workflows = Object.fromEntries(
  [
    planEnginePath,
    applyEnginePath,
    planDispatcherPath,
    applyDispatcherPath,
    initialStateDispatcherPath,
  ].map((path) => [path, parseWorkflow(path)]),
);

describe("P1 infrastructure workflow safety contract", () => {
  it("wires only the reusable engines to the strict live runtime", () => {
    for (const [path, expectedInputs, jobId, timeout] of [
      [planEnginePath, planInputs, "create-plan", 20],
      [applyEnginePath, applyInputs, "apply-plan", 45],
    ]) {
      const workflow = workflows[path];
      assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
      assert.deepEqual(workflow.on.workflow_call, { inputs: expectedInputs });
      assert.deepEqual(workflow.permissions, {
        actions: "read",
        contents: "read",
        "id-token": "write",
      });
      assert.deepEqual(Object.keys(workflow.jobs), [jobId]);
      const job = workflow.jobs[jobId];
      assert.equal(job["runs-on"], "ubuntu-24.04");
      assert.equal(job["timeout-minutes"], timeout);
      assert.equal(job.environment, undefined);
      assert.equal(job.secrets, undefined);
      assert.equal(job.permissions, undefined);
      const uses = job.steps.filter((step) => step.uses !== undefined).map((step) => step.uses);
      assert.equal(uses[0], checkout);
      assert.equal(uses[1], setupNode);
      for (const reference of uses) assert.match(reference, /@[0-9a-f]{40}$/);
    }

    const plan = workflows[planEnginePath].jobs["create-plan"];
    assert.deepEqual(
      plan.steps.filter((step) => step.uses !== undefined).map((step) => step.uses),
      [checkout, setupNode, uploadArtifact],
    );
    const upload = plan.steps.find((step) => step.uses === uploadArtifact);
    assert.deepEqual(upload.with, {
      name: expression("steps.plan.outputs.artifact_name"),
      path: expression("steps.plan.outputs.artifact_path"),
      "if-no-files-found": "error",
      "retention-days": 1,
      "compression-level": 0,
      overwrite: false,
      "include-hidden-files": false,
    });
    assert.match(
      plan.steps.find((step) => step.id === "plan").run,
      /dist\/cli\.js plan[\s\\]+\| node scripts\/infrastructure-approval-result\.mjs plan/,
    );
    assert.match(
      workflows[applyEnginePath].jobs["apply-plan"].steps.find((step) => step.id === "apply").run,
      /dist\/cli\.js apply-saved-plan[\s\\]+\| node scripts\/infrastructure-approval-result\.mjs apply-saved-plan/,
    );
  });

  it("pins the three owner dispatchers to the exact foundation engine SHA", () => {
    const cases = [
      {
        inputBindings: {
          authority_class: expression("inputs.authority_class"),
          commit_sha: expression("inputs.commit_sha"),
        },
        inputs: planInputs,
        jobId: "request-plan",
        jobName: "Request the immutable infrastructure plan engine",
        path: planDispatcherPath,
        uses: `example-org/switchyard/${planEnginePath}@${finalEngineSha}`,
        workflowName: "Owner infrastructure plan, step 1 of 2",
      },
      {
        inputBindings: {
          artifact_id: expression("inputs.artifact_id"),
          commit_sha: expression("inputs.commit_sha"),
          destructive_acknowledgement: expression("inputs.destructive_acknowledgement"),
          plan_digest: expression("inputs.plan_digest"),
          plan_run_id: expression("inputs.plan_run_id"),
        },
        inputs: applyDispatcherInputs,
        jobId: "approve-plan",
        jobName: "Approve the immutable infrastructure apply engine",
        path: applyDispatcherPath,
        uses: `example-org/switchyard/${applyEnginePath}@${finalEngineSha}`,
        workflowName: "Owner infrastructure apply, step 2 of 2",
      },
      {
        inputBindings: {
          artifact_id: "1",
          commit_sha: expression("inputs.commit_sha"),
          destructive_acknowledgement: expression("inputs.acknowledgement"),
          plan_digest: "0".repeat(64),
          plan_run_id: "1",
        },
        inputs: initialStateInputs,
        jobId: "initialise-state",
        jobName: "Initialise the proved-empty Switchyard state once",
        path: initialStateDispatcherPath,
        uses: `example-org/switchyard/${applyEnginePath}@${finalEngineSha}`,
        workflowName: "Owner infrastructure initial state, one time only",
      },
    ];

    for (const fixture of cases) {
      const workflow = workflows[fixture.path];
      assert.deepEqual(Object.keys(workflow), ["name", "on", "permissions", "jobs"]);
      assert.equal(workflow.name, fixture.workflowName);
      assert.deepEqual(workflow.on, { workflow_dispatch: { inputs: fixture.inputs } });
      assert.deepEqual(workflow.permissions, {
        actions: "read",
        contents: "read",
        "id-token": "write",
      });
      assert.deepEqual(Object.keys(workflow.jobs), [fixture.jobId]);
      assert.deepEqual(workflow.jobs[fixture.jobId], {
        name: fixture.jobName,
        uses: fixture.uses,
        with: fixture.inputBindings,
      });
    }
  });

  it("keeps live authority narrowly bounded and dependent on runtime OIDC verification", () => {
    for (const path of [planDispatcherPath, applyDispatcherPath, initialStateDispatcherPath]) {
      const workflow = workflows[path];
      for (const object of allObjects(workflow)) {
        assert.equal(Object.hasOwn(object, "environment"), false, `${path} claims an environment`);
        assert.equal(Object.hasOwn(object, "secrets"), false, `${path} receives secrets`);
        if (Object.hasOwn(object, "permissions")) {
          assert.deepEqual(
            object.permissions,
            { actions: "read", contents: "read", "id-token": "write" },
            `${path} gains unexpected authority`,
          );
        }
      }
      for (const value of allStrings(workflow)) {
        assert.doesNotMatch(value, /actions\/checkout|azure\/login|\baz\s+login\b/i, path);
        assert.doesNotMatch(value, /\b(?:tofu|terraform)\s+(?:plan|apply|destroy)\b/i, path);
        assert.doesNotMatch(value, /\bsecrets\.|\bGITHUB_TOKEN\b/i, path);
      }
    }

    for (const path of [planEnginePath, applyEnginePath]) {
      const source = readFileSync(path, "utf8");
      assert.doesNotMatch(source, /\bsecrets\.|azure\/login|\baz\s+login\b|\benvironment\s*:/i);
      assert.doesNotMatch(source, /\b(?:tofu|terraform)\s+(?:plan|apply|destroy)\b/i);
      assert.match(source, /SWITCHYARD_INFRASTRUCTURE_TARGET_CONFIGURATION_JSON/);
      assert.match(source, /job\.check_run_id/);
      assert.match(source, /job\.workflow_sha/);
      assert.match(source, /SWITCHYARD_JOB_WORKFLOW_SHA/);
      assert.doesNotMatch(source, /initialise-state/);
    }

    assert.deepEqual(workflows[applyEnginePath].concurrency, {
      group: "switchyard-infrastructure-apply",
      "cancel-in-progress": false,
    });
    const activation = readFileSync("infra/foundation/activation.json", "utf8");
    assert.match(activation, new RegExp(`"final_engine_sha":"${finalEngineSha}"`));
    assert.doesNotMatch(activation, /client[_-]?secret|access[_-]?token|private[_-]?key|password/i);

    const initialStateSource = readFileSync(initialStateDispatcherPath, "utf8");
    assert.match(initialStateSource, /INITIALISE EMPTY SWITCHYARD STATE/);
    assert.match(initialStateSource, /plan_digest:\s*"0{64}"/);
    assert.match(initialStateSource, /artifact_id:\s*"1"/);
  });

  it("pins the reviewed OpenTofu archive and extracted binary", () => {
    const source = readFileSync("scripts/install-opentofu.sh", "utf8");
    assert.match(source, /readonly tofu_version="1\.12\.1"/);
    assert.match(
      source,
      /readonly archive_sha256="1fc9af962e3632b7cd0ba27076cd9f1ced177567defe9e331ac37f5a40468575"/,
    );
    assert.match(
      source,
      /readonly binary_sha256="b6cb308bd699c8b53882319986f339eeaa44f925a68f12d5b0a14e6caceedf23"/,
    );
    assert.match(
      source,
      /https:\/\/github\.com\/opentofu\/opentofu\/releases\/download\/v\$\{tofu_version\}\/tofu_\$\{tofu_version\}_linux_amd64\.zip/,
    );
    assert.match(source, /sha256sum --check --strict/g);
    assert.match(source, /expected_entries=\(CHANGELOG\.md LICENSE README\.md tofu\)/);
    assert.doesNotMatch(source, /\beval\b|curl[^\n]*\|/);
  });
});

function parseWorkflow(path) {
  const document = parseDocument(readFileSync(path, "utf8"), {
    maxAliasCount: 0,
    schema: "core",
    uniqueKeys: true,
  });
  assert.deepEqual(document.errors, [], `${path} must be valid, duplicate-free YAML`);
  visit(document, {
    Node(_, node) {
      assert.equal(isAlias(node), false, `${path} must not contain YAML aliases`);
    },
  });
  return document.toJS();
}

function* allObjects(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* allObjects(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  yield value;
  for (const nested of Object.values(value)) yield* allObjects(nested);
}

function* allStrings(value) {
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* allStrings(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    yield key;
    yield* allStrings(nested);
  }
}
