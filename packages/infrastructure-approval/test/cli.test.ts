import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { parseCliRequest, runInfrastructureApprovalCli } from "../src/cli.js";
import {
  APPLY_ENGINE_SHA,
  COMMIT_SHA,
  PLAN_JOB_CHECK_RUN_ID,
  PLAN_RUN_ID,
  bytes,
} from "./fixtures.js";

const FINAL_ENGINE_SHA = "5c9b286fcb5761a3fcf4b4c87882ec56103333e7";
const SECRET = "workflow-credential-that-must-not-leak.".repeat(2);

describe("strict production infrastructure CLI", () => {
  it("accepts only the exact operation discriminator and bounded duplicate-free input", () => {
    assert.deepEqual(
      parseCliRequest(
        bytes(
          JSON.stringify({
            operation: "plan",
            authorityClass: "foundation",
            jobCheckRunId: PLAN_JOB_CHECK_RUN_ID,
          }),
        ),
        "plan",
      ),
      { operation: "plan", authorityClass: "foundation", jobCheckRunId: PLAN_JOB_CHECK_RUN_ID },
    );
    assert.deepEqual(
      parseCliRequest(
        bytes(JSON.stringify({ operation: "initialise-state", jobCheckRunId: "505" })),
        "apply-saved-plan",
      ),
      { operation: "initialise-state", jobCheckRunId: "505" },
    );
    for (const input of [
      "{}",
      '{"operation":"plan","operation":"plan","authorityClass":"foundation","jobCheckRunId":"404"}',
      '{"operation":"apply-saved-plan","authorityClass":"foundation","jobCheckRunId":"404"}',
      JSON.stringify({
        operation: "plan",
        authorityClass: "foundation",
        jobCheckRunId: "404",
        token: SECRET,
      }),
    ]) {
      assert.throws(() => parseCliRequest(bytes(input), "plan"));
    }
  });

  it("fails on an absent activation file before network use and redacts credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "switchyard-cli-disabled-"));
    const runnerTemp = await mkdtemp(join(tmpdir(), "switchyard-cli-runner-"));
    const environment: NodeJS.ProcessEnv = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: SECRET,
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/token?id=1",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: PLAN_RUN_ID,
      GITHUB_SHA: COMMIT_SHA,
      GITHUB_TOKEN: SECRET,
      GITHUB_WORKSPACE: root,
      RUNNER_TEMP: runnerTemp,
      SWITCHYARD_JOB_WORKFLOW_SHA: APPLY_ENGINE_SHA,
      SWITCHYARD_TARGET_CONFIGURATION_JSON: "{}",
    };
    try {
      await assert.rejects(
        () =>
          runInfrastructureApprovalCli(
            ["plan"],
            environment,
            bytes(
              JSON.stringify({
                operation: "plan",
                authorityClass: "foundation",
                jobCheckRunId: PLAN_JOB_CHECK_RUN_ID,
              }),
            ),
          ),
        (error: unknown) =>
          error instanceof Error &&
          error.message === "activation-configuration-absent" &&
          !error.message.includes(SECRET),
      );
      assert.equal(environment.GITHUB_TOKEN, undefined);
      assert.equal(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
      assert.equal(environment.SWITCHYARD_JOB_WORKFLOW_SHA, undefined);
      assert.equal(environment.SWITCHYARD_TARGET_CONFIGURATION_JSON, undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("uses only the final immutable engines and the separately gated initial-state caller", async () => {
    const repositoryRoot = resolve("../..");
    const planDispatcher = await workflow(repositoryRoot, "infrastructure-plan.yml");
    const applyDispatcher = await workflow(repositoryRoot, "infrastructure-apply.yml");
    const initialStateDispatcher = await workflow(
      repositoryRoot,
      "infrastructure-initialise-state.yml",
    );
    const planEngine = await workflow(repositoryRoot, "infrastructure-plan-engine.yml");
    const applyEngine = await workflow(repositoryRoot, "infrastructure-apply-engine.yml");
    assert.match(planDispatcher, new RegExp(`@${FINAL_ENGINE_SHA}`));
    assert.match(applyDispatcher, new RegExp(`@${FINAL_ENGINE_SHA}`));
    assert.match(initialStateDispatcher, new RegExp(`@${FINAL_ENGINE_SHA}`));
    for (const source of [planDispatcher, applyDispatcher, initialStateDispatcher]) {
      assert.match(source, /id-token:\s*write/);
      assert.doesNotMatch(source, /switchyard-infrastructure-approval|dist\/cli|apply-saved-plan/);
    }
    for (const source of [planEngine, applyEngine]) {
      assert.match(source, /id-token:\s*write/);
      assert.match(source, /packages\/infrastructure-approval\/dist\/cli\.js/);
      assert.match(source, /\(unreachable\)/);
      assert.doesNotMatch(source, /initialise-state/);
    }
    assert.match(initialStateDispatcher, /INITIALISE EMPTY SWITCHYARD STATE/);
    assert.match(initialStateDispatcher, /plan_digest:\s*"0{64}"/);
  });

  it("contains only canonical non-secret activation evidence and no raw credential material", async () => {
    const repositoryRoot = resolve("../..");
    const activation = await readFile(
      join(repositoryRoot, "infra/foundation/activation.json"),
      "utf8",
    );
    assert.match(activation, new RegExp(FINAL_ENGINE_SHA));
    assert.doesNotMatch(
      activation,
      /client[_-]?secret|access[_-]?token|private[_-]?key|password|sas[_-]?token/i,
    );
    const modules = ["cli.ts", "entra-live.ts", "github-live.ts", "opentofu-live.ts"];
    for (const module of modules) {
      const source = await readFile(
        join(repositoryRoot, "packages/infrastructure-approval/src", module),
        "utf8",
      );
      assert.equal(source.includes(SECRET), false);
    }
  });
});

function workflow(repositoryRoot: string, name: string): Promise<string> {
  return readFile(join(repositoryRoot, ".github/workflows", name), "utf8");
}
