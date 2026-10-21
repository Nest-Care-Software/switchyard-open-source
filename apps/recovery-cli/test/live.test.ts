import assert from "node:assert/strict";
import test from "node:test";

import { ReducedGitHubRecoveryPort, RecoverySafetyError } from "../src/index.js";

const runnerLabel = `switchyard-sy1-${"a".repeat(64)}`;
const token = "github-token-placeholder-that-is-never-real";

test("runner fencing requires separated absence scans and catches delayed registration", async () => {
  const pages = [[], [runner(42, [runnerLabel])], [], []];
  const deletes: string[] = [];
  let waits = 0;
  const port = new ReducedGitHubRecoveryPort({
    fetch: async (input, init) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        deletes.push(url);
        return new Response(null, { status: 204 });
      }
      return Response.json({ runners: pages.shift() ?? [] });
    },
    token,
    wait: async () => {
      waits += 1;
    },
  });
  const result = await port.fenceExactRunnerLabel({ runnerLabel });
  assert.equal(result.registrationsDeleted, 1);
  assert.equal(waits, 3);
  assert.equal(deletes.length, 1);
  assert.match(deletes[0] ?? "", /\/actions\/runners\/42$/);
});

test("a runner with competing Switchyard labels fails closed", async () => {
  const port = new ReducedGitHubRecoveryPort({
    fetch: async () =>
      Response.json({
        runners: [runner(42, [runnerLabel, `switchyard-sy1-${"b".repeat(64)}`])],
      }),
    token,
    wait: async () => {},
  });
  await assert.rejects(port.fenceExactRunnerLabel({ runnerLabel }), RecoverySafetyError);
});

function runner(id: number, labels: readonly string[]) {
  return { id, labels: labels.map((name) => ({ name })) };
}
