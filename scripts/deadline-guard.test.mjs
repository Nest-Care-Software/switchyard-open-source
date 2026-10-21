import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const bootstrap = readFileSync("infra/assets/azure-runner/bootstrap.sh", "utf8");
const match = /<<'DEADLINE_GUARD'\n(?<script>[\s\S]*?)\nDEADLINE_GUARD\n/.exec(bootstrap);
assert.ok(match?.groups?.script, "deadline guard heredoc is missing from the bootstrap");

const allocationId = `sy1-${"a".repeat(64)}`;
const latestSafeStart = "2026-08-25T10:10:00.000Z";
const computeDeadline = "2026-08-25T10:40:00.000Z";
const latestSafeStartMs = Date.parse(latestSafeStart);
const computeDeadlineMs = Date.parse(computeDeadline);

test("the pre-job hook authorises one start before the cutoff", () => {
  const fixture = createFixture();
  try {
    fixture.setNow(latestSafeStartMs - 1);
    assert.equal(fixture.run("record-start").status, 0);
    assert.match(
      readFileSync(join(fixture.root, "state/job-started"), "utf8"),
      new RegExp(`started_at_epoch_ms=${latestSafeStartMs - 1}$`, "m"),
    );
    assert.deepEqual(
      fixture.evidence().map(({ result_code }) => result_code),
      ["job-start-authorised"],
    );

    fixture.setNow(latestSafeStartMs - 1);
    assert.equal(fixture.run("record-start").status, 78, "a second job is never accepted");
    assert.deepEqual(
      fixture.evidence().map(({ result_code }) => result_code),
      ["job-start-authorised", "job-start-rejected"],
    );
  } finally {
    fixture.remove();
  }
});

test("the pre-job hook authorises a start exactly at the cutoff", () => {
  const fixture = createFixture();
  try {
    fixture.setNow(latestSafeStartMs);
    assert.equal(fixture.run("record-start").status, 0);
    assert.match(
      readFileSync(join(fixture.root, "state/job-started"), "utf8"),
      new RegExp(`started_at_epoch_ms=${latestSafeStartMs}$`, "m"),
    );
  } finally {
    fixture.remove();
  }
});

test("the pre-job hook rejects a start after the cutoff", () => {
  const fixture = createFixture();
  try {
    fixture.setNow(latestSafeStartMs + 1);
    assert.equal(fixture.run("record-start").status, 78);
    assert.equal(fixture.has("state/job-started"), false);
    assert.deepEqual(
      fixture.evidence().map(({ result_code }) => result_code),
      ["job-start-rejected"],
    );
  } finally {
    fixture.remove();
  }
});

test("the persistent timer wins equality and fences when no hook holds the lock", () => {
  const fixture = createFixture();
  try {
    fixture.setNow(latestSafeStartMs);
    assert.equal(fixture.run("latest-safe-start").status, 0);
    assert.equal(fixture.has("state/poweroff-requested"), true);
    assert.deepEqual(
      fixture.evidence().map(({ result_code }) => result_code),
      ["runner-fenced-at-cutoff"],
    );
    assert.equal(
      fixture.run("record-start").status,
      78,
      "a timer that won the equality race remains authoritative",
    );
  } finally {
    fixture.remove();
  }
});

test("a timely job is not fenced at latest safe start and is fenced at CompleteBy", () => {
  const fixture = createFixture();
  try {
    fixture.setNow(latestSafeStartMs - 1);
    assert.equal(fixture.run("record-start").status, 0);
    fixture.setNow(latestSafeStartMs);
    assert.equal(fixture.run("latest-safe-start").status, 0);
    assert.equal(fixture.has("state/poweroff-requested"), false);
    fixture.setNow(computeDeadlineMs);
    assert.equal(fixture.run("compute-deadline").status, 0);
    assert.equal(fixture.has("state/poweroff-requested"), true);
    assert.deepEqual(
      fixture.evidence().map(({ result_code }) => result_code),
      ["job-start-authorised", "compute-deadline-fenced"],
    );
  } finally {
    fixture.remove();
  }
});

test("CompleteBy remains armed after a timely start and is retry-idempotent", () => {
  const fixture = createFixture();
  try {
    fixture.setNow(latestSafeStartMs - 1);
    assert.equal(fixture.run("record-start").status, 0);
    fixture.setNow(computeDeadlineMs);
    assert.equal(fixture.run("compute-deadline").status, 0);
    rmSync(join(fixture.root, "state/poweroff-requested"));
    fixture.setNow(computeDeadlineMs + 1);
    assert.equal(fixture.run("compute-deadline").status, 0);
    assert.equal(fixture.has("state/poweroff-requested"), true);
  } finally {
    fixture.remove();
  }
});

test("a boot identity change fails closed instead of extending either deadline", () => {
  const fixture = createFixture();
  try {
    writeFileSync(join(fixture.root, "boot-id"), "22222222-2222-4222-8222-222222222222\n");
    assert.equal(fixture.run("validate").status, 70);
  } finally {
    fixture.remove();
  }
});

test("monotonic elapsed time prevents UTC rollback from extending the cutoff", () => {
  const fixture = createFixture();
  try {
    fixture.setNow(latestSafeStartMs - 10_000, 2_001);
    assert.equal(fixture.run("record-start").status, 78);
  } finally {
    fixture.remove();
  }
});

for (const [offset, expectedStatus] of [
  [-1, 0],
  [0, 78],
  [1, 78],
]) {
  test(`JIT launch applies the strict latest-safe-start boundary at offset ${offset}`, () => {
    const fixture = createFixture();
    try {
      fixture.setNow(latestSafeStartMs + offset);
      assert.equal(fixture.run("allow-jit-launch").status, expectedStatus);
    } finally {
      fixture.remove();
    }
  });
}

for (const corrupt of [
  "",
  `format_version=1\nallocation_id=${allocationId}\nphysical_generation=1\nlatest_safe_start=${computeDeadline}\ncompute_deadline=${latestSafeStart}\n`,
  `format_version=1\nallocation_id=${allocationId}\nphysical_generation=2\nlatest_safe_start=${latestSafeStart}\ncompute_deadline=${computeDeadline}\n`,
]) {
  test("missing or corrupt immutable guard state fails closed", () => {
    const fixture = createFixture();
    try {
      chmodSync(join(fixture.root, "deadline-guard.conf"), 0o644);
      writeFileSync(join(fixture.root, "deadline-guard.conf"), corrupt);
      chmodSync(join(fixture.root, "deadline-guard.conf"), 0o444);
      assert.equal(fixture.run("validate").status, 70);
    } finally {
      fixture.remove();
    }
  });
}

function createFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "switchyard-deadline-guard-"));
  const scriptPath = join(root, "guard.sh");
  writeFileSync(scriptPath, `${match.groups.script}\n`, { mode: 0o755 });
  const selectedLatestSafeStart = overrides.latestSafeStart ?? latestSafeStart;
  const selectedComputeDeadline = overrides.computeDeadline ?? computeDeadline;
  const anchorUtcMs = Date.parse(selectedLatestSafeStart) - 1_000;
  const bootId = "11111111-1111-4111-8111-111111111111";
  writeFileSync(
    join(root, "deadline-guard.conf"),
    [
      "format_version=1",
      `allocation_id=${allocationId}`,
      "physical_generation=1",
      "mapped_job_timeout_minutes=25",
      "provider_stop_margin_minutes=5",
      `latest_safe_start=${selectedLatestSafeStart}`,
      `compute_deadline=${selectedComputeDeadline}`,
      `boot_id=${bootId}`,
      `anchor_utc_epoch_ms=${anchorUtcMs}`,
      "anchor_monotonic_ms=1000",
      "",
    ].join("\n"),
    { mode: 0o444 },
  );
  chmodSync(join(root, "deadline-guard.conf"), 0o444);
  writeFileSync(join(root, "boot-id"), `${bootId}\n`);
  const environment = { ...process.env, SWITCHYARD_GUARD_TEST_ROOT: root };
  return {
    evidence: () => {
      if (!fixtureHas(root, "state/evidence.jsonl")) return [];
      return readFileSync(join(root, "state/evidence.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    has: (path) => fixtureHas(root, path),
    remove: () => rmSync(root, { force: true, recursive: true }),
    root,
    run: (command) => spawnSync(scriptPath, [command], { env: environment, encoding: "utf8" }),
    setNow: (value, monotonic = 1_000 + Math.max(0, value - anchorUtcMs)) => {
      writeFileSync(join(root, "now-ms"), `${value}\n`);
      writeFileSync(join(root, "monotonic-ms"), `${monotonic}\n`);
    },
  };
}

function fixtureHas(root, path) {
  try {
    readFileSync(join(root, path));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
