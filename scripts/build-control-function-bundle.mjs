import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

const repositoryRoot = resolve(import.meta.dirname, "..");
const applicationRoot = join(repositoryRoot, "apps/control-function");
const outputDirectory = join(repositoryRoot, ".artifacts/control-function");
const outputPath = join(outputDirectory, "switchyard-control-function.zip");
const digestPath = `${outputPath}.sha256`;
const assetsOnly = process.argv.includes("--assets-only");
const checkDeterminism = process.argv.includes("--check");
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => !["--assets-only", "--check"].includes(argument));
assert.deepEqual(unknownArguments, [], `unknown arguments: ${unknownArguments.join(", ")}`);

const forbiddenRuntimePackages = new Set([
  "@switchyard/azure-ledger-bootstrap",
  "@switchyard/reporting",
  "@switchyard/reporting-worker",
  "@switchyard/recovery",
  "@switchyard/recovery-cli",
  "cloudflare",
  "wrangler",
]);
const allowedSwitchyardPackages = new Set([
  "azure-ledger",
  "azure-worker",
  "controller",
  "core",
  "github",
  "reconciler",
]);
const crc32Table = Array.from({ length: 256 }, (_, value) => {
  let entry = value;
  for (let index = 0; index < 8; index += 1) {
    entry = entry & 1 ? 0xedb88320 ^ (entry >>> 1) : entry >>> 1;
  }
  return entry >>> 0;
});

const runtimeAssets = await readRuntimeAssets();
if (assetsOnly) {
  console.log("Verified the pinned non-secret Azure runner bootstrap and ARM runtime assets.");
  process.exit(0);
}

const entries = new Map();
await addFile(entries, join(applicationRoot, "host.json"), "host.json");
await addFile(entries, join(applicationRoot, "package.json"), "package.json");
await addApplicationOutput(entries);
await addProductionDependencies(entries);
for (const asset of runtimeAssets) entries.set(asset.archivePath, asset.entry);

const lockContents = await readFile(join(repositoryRoot, "package-lock.json"));
const manifestEntries = [...entries.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, entry]) => ({
    mode: entry.mode.toString(8).padStart(4, "0"),
    path,
    sha256: sha256(entry.contents),
    size: entry.contents.byteLength,
  }));
const bundleManifest = {
  entrypoint: "dist/entry.js",
  files: manifestEntries,
  format_version: 1,
  lockfile_sha256: sha256(lockContents),
  node_major: 24,
};
entries.set("bundle-manifest.json", {
  contents: Buffer.from(`${JSON.stringify(bundleManifest, null, 2)}\n`),
  mode: 0o644,
});

scanBundle(entries);
const firstBundle = createZip(entries);
if (checkDeterminism) {
  const secondBundle = createZip(new Map([...entries.entries()].reverse()));
  assert.deepEqual(firstBundle, secondBundle, "Function bundle is not deterministic");
}

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, firstBundle, { mode: 0o644 });
const bundleDigest = sha256(firstBundle);
await writeFile(digestPath, `${bundleDigest}  ${basename(outputPath)}\n`, { mode: 0o644 });
execFileSync("unzip", ["-tqq", outputPath], { stdio: "pipe" });
console.log(
  `Built deterministic Function bundle ${relative(repositoryRoot, outputPath)} (${bundleDigest}).`,
);

async function readRuntimeAssets() {
  const definitions = [
    {
      archivePath: "runtime-assets/azure-allocation/main.json",
      sourcePath: join(repositoryRoot, "infra/templates/azure-allocation/main.json"),
    },
    {
      archivePath: "runtime-assets/azure-allocation/jit-launch.json",
      sourcePath: join(repositoryRoot, "infra/templates/azure-allocation/jit-launch.json"),
    },
    {
      archivePath: "runtime-assets/azure-runner/bootstrap.sh",
      sourcePath: join(repositoryRoot, "infra/assets/azure-runner/bootstrap.sh"),
    },
    {
      archivePath: "runtime-assets/azure-runner/manifest.json",
      sourcePath: join(repositoryRoot, "infra/assets/azure-runner/manifest.json"),
    },
  ];
  const assets = [];
  for (const definition of definitions) {
    const contents = await readFile(definition.sourcePath);
    assets.push({
      ...definition,
      entry: {
        contents,
        mode: definition.sourcePath.endsWith(".sh") ? 0o755 : 0o644,
      },
    });
  }

  const bootstrap = assets.find(({ archivePath }) => archivePath.endsWith("bootstrap.sh"));
  const runnerManifest = assets.find(({ archivePath }) => archivePath.endsWith("manifest.json"));
  assert.ok(bootstrap && runnerManifest);
  assert.ok(
    bootstrap.entry.contents.byteLength <= 48 * 1024,
    "bootstrap exceeds the reviewed custom-data bound",
  );
  const manifest = strictJson(runnerManifest.entry.contents, [
    "architecture",
    "bootstrap_sha256",
    "operating_system",
    "runner_archive_sha256",
    "runner_archive_url",
    "runner_version",
  ]);
  assert.equal(manifest.architecture, "x64");
  assert.equal(manifest.operating_system, "Canonical Ubuntu 24.04 LTS Gen2");
  assert.match(manifest.runner_version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.match(manifest.runner_archive_sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.bootstrap_sha256, sha256(bootstrap.entry.contents));
  assert.equal(
    manifest.runner_archive_url,
    `https://github.com/actions/runner/releases/download/v${manifest.runner_version}/actions-runner-linux-x64-${manifest.runner_version}.tar.gz`,
  );
  const bootstrapText = bootstrap.entry.contents.toString("utf8");
  for (const expected of [
    `readonly runner_version="${manifest.runner_version}"`,
    `readonly runner_sha256="${manifest.runner_archive_sha256}"`,
    "ACTIONS_RUNNER_DISABLEUPDATE=1",
    "/dev/disk/azure/resource",
    "docker info >/dev/null",
    "switchyard-resource-disk.service",
    "switchyard-runner-readiness",
    "switchyard-deadline-guard",
    "ACTIONS_RUNNER_HOOK_JOB_STARTED",
    "mappedJobTimeoutMinutes",
    "providerStopMarginMinutes",
    "/dev/ptp_hyperv",
    "root:root:444",
  ]) {
    assert.ok(bootstrapText.includes(expected), `bootstrap is missing ${expected}`);
  }
  assert.doesNotMatch(
    bootstrapText,
    /(?:SWITCHYARD_REDUCED_JIT_CONFIG|ACTIONS_RUNNER_INPUT_JITCONFIG|registration[_ -]?token|private[_ -]?key)/i,
  );
  for (const asset of assets.filter(({ archivePath }) => archivePath.endsWith(".json"))) {
    JSON.parse(asset.entry.contents.toString("utf8"));
  }
  return assets;
}

async function addApplicationOutput(entries) {
  const outputRoot = join(applicationRoot, "dist");
  const outputFiles = await regularFiles(outputRoot);
  assert.ok(outputFiles.length > 0, "control-function output is absent; run its build first");
  for (const sourcePath of outputFiles) {
    if (!/\.(?:c?js|mjs|json)$/.test(sourcePath)) continue;
    await addFile(entries, sourcePath, relative(applicationRoot, sourcePath));
  }
  assert.ok(entries.has("dist/entry.js"), "control-function dist/entry.js is required");
}

async function addProductionDependencies(entries) {
  const applicationManifest = JSON.parse(
    await readFile(join(applicationRoot, "package.json"), "utf8"),
  );
  const pending = Object.keys(applicationManifest.dependencies ?? {}).map((name) => ({
    name,
    parentRoot: applicationRoot,
  }));
  const visited = new Set();
  while (pending.length > 0) {
    const dependency = pending.shift();
    assert.ok(dependency);
    assert.ok(
      !forbiddenRuntimePackages.has(dependency.name),
      `${dependency.name} is forbidden from the runtime bundle`,
    );
    const packageRoot = await resolvePackageRoot(dependency.name, dependency.parentRoot);
    const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(
      packageManifest.name,
      dependency.name,
      `resolved package name mismatch for ${dependency.name}`,
    );
    const archiveRoot = packageRoot.startsWith(`${repositoryRoot}${sep}packages${sep}`)
      ? `node_modules/${dependency.name}`
      : relative(repositoryRoot, packageRoot).split(sep).join("/");
    assert.match(
      archiveRoot,
      /^(?:node_modules\/)/,
      `dependency escaped node_modules: ${dependency.name}`,
    );
    const visitKey = `${archiveRoot}\0${packageRoot}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    const packageFiles = await regularFiles(packageRoot, { skipNodeModules: true });
    for (const sourcePath of packageFiles) {
      const packageRelativePath = relative(packageRoot, sourcePath).split(sep).join("/");
      if (!isRuntimePackageFile(packageRelativePath)) continue;
      await addFile(entries, sourcePath, `${archiveRoot}/${packageRelativePath}`);
    }
    assert.ok(
      entries.has(`${archiveRoot}/package.json`),
      `${dependency.name} package manifest is absent`,
    );

    const required = Object.keys(packageManifest.dependencies ?? {});
    const optional = Object.keys(packageManifest.optionalDependencies ?? {});
    const peers = Object.keys(packageManifest.peerDependencies ?? {});
    for (const childName of [...new Set([...required, ...optional, ...peers])].sort()) {
      if (forbiddenRuntimePackages.has(childName)) {
        assert.fail(`${dependency.name} depends on forbidden runtime package ${childName}`);
      }
      try {
        await resolvePackageRoot(childName, packageRoot);
        pending.push({ name: childName, parentRoot: packageRoot });
      } catch (error) {
        if (required.includes(childName)) throw error;
      }
    }
  }
}

async function resolvePackageRoot(packageName, parentRoot) {
  for (const workspaceArea of ["apps", "packages"]) {
    const candidates = await readdir(join(repositoryRoot, workspaceArea), { withFileTypes: true });
    for (const candidate of candidates) {
      if (!candidate.isDirectory()) continue;
      const candidateRoot = join(repositoryRoot, workspaceArea, candidate.name);
      try {
        const manifest = JSON.parse(await readFile(join(candidateRoot, "package.json"), "utf8"));
        if (manifest.name === packageName) return await realpath(candidateRoot);
      } catch {
        // This directory is not the requested workspace package.
      }
    }
  }
  const requireFromParent = createRequire(join(parentRoot, "package.json"));
  try {
    return await realpath(dirname(requireFromParent.resolve(`${packageName}/package.json`)));
  } catch {
    let resolvedEntry;
    try {
      resolvedEntry = requireFromParent.resolve(packageName);
    } catch {
      resolvedEntry = fileURLToPath(
        import.meta.resolve(packageName, pathToFileURL(join(parentRoot, "package.json")).href),
      );
    }
    let candidate = dirname(resolvedEntry);
    while (candidate !== dirname(candidate)) {
      const candidateManifest = join(candidate, "package.json");
      try {
        const manifest = JSON.parse(await readFile(candidateManifest, "utf8"));
        if (manifest.name === packageName) return await realpath(candidate);
      } catch {
        // Keep walking to the owning package root.
      }
      candidate = dirname(candidate);
    }
  }
  throw new Error(`could not resolve package root for ${packageName}`);
}

async function regularFiles(root, options = {}) {
  const files = [];
  const walk = async (directory) => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (options.skipNodeModules && child.name === "node_modules") continue;
      const path = join(directory, child.name);
      if (child.isDirectory()) await walk(path);
      else if (child.isFile() || child.isSymbolicLink()) files.push(path);
    }
  };
  await walk(root);
  return files.sort();
}

function isRuntimePackageFile(path) {
  if (path === "package.json") return true;
  if (/^(?:test|tests|docs?|examples?|coverage)\//i.test(path)) return false;
  if (/(?:^|\/)(?:readme|changelog|license|notice)(?:\.[^/]*)?$/i.test(path)) return false;
  if (/\.(?:md|map|ts|tsx)$/i.test(path)) return false;
  return true;
}

async function addFile(entries, sourcePath, archivePath) {
  const normalPath = archivePath.split(sep).join("/");
  assertSafeArchivePath(normalPath);
  const sourceStat = await lstat(sourcePath);
  const resolvedSource = sourceStat.isSymbolicLink() ? await realpath(sourcePath) : sourcePath;
  const resolvedStat = await stat(resolvedSource);
  assert.ok(resolvedStat.isFile(), `${sourcePath} is not a regular file`);
  const entry = {
    contents: await readFile(resolvedSource),
    mode: resolvedStat.mode & 0o111 ? 0o755 : 0o644,
  };
  const existing = entries.get(normalPath);
  if (existing) assert.deepEqual(existing, entry, `archive path collision: ${normalPath}`);
  else entries.set(normalPath, entry);
}

function scanBundle(entries) {
  for (const [path, entry] of entries) {
    assertSafeArchivePath(path);
    assert.doesNotMatch(path, /(?:^|\/)(?:\.env|[^/]+\.(?:pem|key|tfstate|tfvars))(?:$|\/)/i);
    for (const forbiddenPackage of forbiddenRuntimePackages) {
      assert.ok(
        !path.includes(`/node_modules/${forbiddenPackage}/`) &&
          !path.startsWith(`node_modules/${forbiddenPackage}/`),
      );
    }
    const switchyardPackage = /^node_modules\/@switchyard\/([^/]+)\//.exec(path)?.[1];
    if (switchyardPackage !== undefined) {
      assert.ok(
        allowedSwitchyardPackages.has(switchyardPackage),
        `unreviewed Switchyard package in Function bundle: ${switchyardPackage}`,
      );
    }
    const text = entry.contents.toString("utf8");
    assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
    assert.doesNotMatch(text, /\bgh[opusr]_[A-Za-z0-9_]{24,}\b/);
  }
}

function strictJson(contents, expectedKeys) {
  const value = JSON.parse(contents.toString("utf8"));
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expectedKeys].sort());
  return value;
}

function assertSafeArchivePath(path) {
  assert.ok(path.length > 0 && path.length <= 240);
  assert.ok(!path.startsWith("/") && !path.includes("\\") && !path.includes("\0"));
  assert.ok(path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."));
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [path, entry] of [...entries.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const name = Buffer.from(path, "utf8");
    const compressed = deflateRawSync(entry.contents, { level: 9 });
    const checksum = crc32(entry.contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(entry.contents.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.contents.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((0o100000 | entry.mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + compressed.byteLength;
  }
  assert.ok(entries.size <= 0xffff && offset <= 0xffffffff, "bundle exceeds ZIP32 bounds");
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}
