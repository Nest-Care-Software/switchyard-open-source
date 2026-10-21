import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseDocument } from "yaml";

const path = ".github/actions/allocate/action.yml";
const source = readFileSync(path, "utf8");
const document = parseDocument(source, { schema: "core", uniqueKeys: true });
if (document.errors.length !== 0) throw document.errors[0];
const action = document.toJS();

describe("private allocation action", () => {
  it("runs only the checked-in standalone Node 24 client", () => {
    assert.deepEqual(Object.keys(action), ["name", "description", "outputs", "runs"]);
    assert.deepEqual(Object.keys(action.outputs), ["runner_label", "allocation_id"]);
    assert.deepEqual(action.runs, { using: "node24", main: "index.mjs" });
    assert.equal(source.includes("inputs:"), false);
  });
});
