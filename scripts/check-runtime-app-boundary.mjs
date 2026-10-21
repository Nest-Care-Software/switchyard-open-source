import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const FORBIDDEN_PACKAGES = ["@switchyard/azure-ledger-bootstrap"];
const CONTROL_FUNCTION_FORBIDDEN_PACKAGES = ["@switchyard/reporting", "@cloudflare/workers-types"];
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const ARTIFACT_DIRECTORY_NAMES = new Set([
  ".output",
  ".test-dist",
  ".wrangler",
  "build",
  "bundle",
  "bundled",
  "dist",
  "out",
]);
const BUNDLED_BOOTSTRAP_MARKERS = [
  ...FORBIDDEN_PACKAGES,
  ...FORBIDDEN_PACKAGES.map((name) => name.replace("/", "\\/")),
  "AzureTableLedgerBootstrap",
  "createAzureTableLedgerBootstrap",
  "switchyard-ledger-provisioning",
];

export function runtimeAppBoundaryViolations({ appsRoot = "apps", artifactRoots = [] } = {}) {
  const violations = [];
  const resolvedAppsRoot = resolve(appsRoot);
  if (existsSync(resolvedAppsRoot)) {
    for (const file of filesBelow(resolvedAppsRoot)) {
      const relativePath = displayPath(file);
      const forbiddenPackages = isControlFunctionFile(file, resolvedAppsRoot)
        ? [...FORBIDDEN_PACKAGES, ...CONTROL_FUNCTION_FORBIDDEN_PACKAGES]
        : FORBIDDEN_PACKAGES;
      if (basename(file) === "package.json") {
        inspectManifest(file, relativePath, violations, forbiddenPackages);
        continue;
      }
      const contents = readFileSync(file);
      if (SOURCE_EXTENSIONS.has(extname(file))) {
        for (const forbiddenPackage of forbiddenPackages) {
          if (contents.includes(Buffer.from(forbiddenPackage))) {
            violations.push(`source import/reference to ${forbiddenPackage} in ${relativePath}`);
          }
        }
      }
      if (isBuiltAppArtifact(file, resolvedAppsRoot)) {
        inspectArtifact(contents, relativePath, violations, forbiddenPackages);
      }
    }
  }

  for (const artifactRoot of artifactRoots) {
    const resolvedArtifactRoot = resolve(artifactRoot);
    if (!existsSync(resolvedArtifactRoot)) {
      violations.push(
        `required built artifact root is missing: ${displayPath(resolvedArtifactRoot)}`,
      );
      continue;
    }
    for (const file of filesBelow(resolvedArtifactRoot)) {
      inspectArtifact(readFileSync(file), displayPath(file), violations, FORBIDDEN_PACKAGES);
    }
  }

  return [...new Set(violations)].sort();
}

export function assertRuntimeAppBoundary(options = {}) {
  const violations = runtimeAppBoundaryViolations(options);
  if (violations.length !== 0) {
    throw new Error(
      `Runtime app boundary rejected a provisioning/reporting dependency:\n${violations
        .map((violation) => `- ${violation}`)
        .join("\n")}`,
    );
  }
}

function inspectManifest(file, relativePath, violations, forbiddenPackages) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot validate app manifest ${relativePath}`, { cause: error });
  }
  for (const section of DEPENDENCY_SECTIONS) {
    for (const forbiddenPackage of forbiddenPackages) {
      if (manifest[section]?.[forbiddenPackage] !== undefined) {
        violations.push(`${forbiddenPackage} in ${section} in ${relativePath}`);
      }
    }
  }
}

function inspectArtifact(contents, relativePath, violations, forbiddenPackages) {
  const markers = [
    ...BUNDLED_BOOTSTRAP_MARKERS,
    ...forbiddenPackages,
    ...forbiddenPackages.map((name) => name.replace("/", "\\/")),
  ];
  for (const marker of markers) {
    if (contents.includes(Buffer.from(marker))) {
      violations.push(`built/bundled bootstrap occurrence in ${relativePath}`);
      return;
    }
  }
}

function isControlFunctionFile(file, appsRoot) {
  return relative(appsRoot, file).split(sep)[0] === "control-function";
}

function isBuiltAppArtifact(file, appsRoot) {
  const segments = relative(appsRoot, file).split(sep);
  return segments.some((segment) => ARTIFACT_DIRECTORY_NAMES.has(segment));
}

function* filesBelow(root) {
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) {
      continue;
    }
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      yield* filesBelow(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function displayPath(path) {
  const fromRepository = relative(process.cwd(), path);
  return fromRepository.startsWith("..") ? path : fromRepository;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  assertRuntimeAppBoundary();
  console.log("Verified that runtime apps and built artefacts contain no ledger bootstrap code.");
}
