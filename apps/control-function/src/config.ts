import { CONTROL_LEDGER_SCHEMA_VERSION } from "@switchyard/core";

const SAFETY_KEYS = [
  "SWITCHYARD_AZURE_IMAGE_VERSION",
  "SWITCHYARD_AZURE_SUBSCRIPTION_ID",
  "SWITCHYARD_BOOTSTRAP_SHA256",
  "SWITCHYARD_FUNCTION_ARTIFACT_SHA256",
  "SWITCHYARD_LEDGER_ACCOUNT_NAME",
  "SWITCHYARD_LEDGER_INSTANCE_ID",
  "SWITCHYARD_LEDGER_PARTITION_KEY",
  "SWITCHYARD_LEDGER_SCHEMA_VERSION",
  "SWITCHYARD_LEDGER_TABLE_NAME",
  "SWITCHYARD_MANAGED_IDENTITY_CLIENT_ID",
  "SWITCHYARD_PROVISIONING_POISON_QUEUE",
  "SWITCHYARD_PROVISIONING_QUEUE",
  "SWITCHYARD_RUNNER_SUBNET_ID",
  "SWITCHYARD_RUNTIME_INSTANCE_ID",
  "SWITCHYARD_TEMPLATE_SHA256",
] as const;

const ADMISSION_KEYS = [
  "SWITCHYARD_BLACKSMITH_LARGE_COST_CENTS",
  "SWITCHYARD_BLACKSMITH_STANDARD_COST_CENTS",
  "SWITCHYARD_CHECK_RUN_APP_SLUG",
  "SWITCHYARD_DOPPLER_CONFIG",
  "SWITCHYARD_DOPPLER_GITHUB_PRIVATE_KEY_NAME",
  "SWITCHYARD_DOPPLER_OIDC_AUDIENCE",
  "SWITCHYARD_DOPPLER_PROJECT",
  "SWITCHYARD_ENTRA_ANCILLARY_CLAIMS_JSON",
  "SWITCHYARD_ENTRA_API_AUDIENCE",
  "SWITCHYARD_ENTRA_CLIENT_APPLICATION_ID",
  "SWITCHYARD_ENTRA_DEDICATED_ROLE",
  "SWITCHYARD_ENTRA_EXPECTED_AUTHENTICATION_TYPE",
  "SWITCHYARD_ENTRA_EXPECTED_IDENTITY_TYPE",
  "SWITCHYARD_ENTRA_EXPECTED_ISSUER",
  "SWITCHYARD_ENTRA_EXPECTED_NAME_CLAIM_TYPE",
  "SWITCHYARD_ENTRA_SECURITY_CLAIMS_JSON",
  "SWITCHYARD_ENTRA_TENANT_ID",
  "SWITCHYARD_ENTRA_TOKEN_VERSION",
  "SWITCHYARD_GITHUB_ACTOR_LOGIN",
  "SWITCHYARD_GITHUB_APP_CLIENT_ID",
  "SWITCHYARD_GITHUB_APP_INSTALLATION_ID",
  "SWITCHYARD_GITHUB_APP_SLUG",
  "SWITCHYARD_GITHUB_ORGANISATION",
  "SWITCHYARD_GITHUB_ORGANISATION_ID",
  "SWITCHYARD_GITHUB_PROOF_AUDIENCE",
  "SWITCHYARD_GITHUB_REUSABLE_WORKFLOW_SHA",
  "SWITCHYARD_GITHUB_RUNNER_GROUP_ID",
  "SWITCHYARD_GITHUB_SWITCHYARD_REPOSITORY_ID",
  "SWITCHYARD_AZURE_LARGE_COST_CENTS",
  "SWITCHYARD_AZURE_STANDARD_COST_CENTS",
] as const;

const FORBIDDEN_SECRET_KEYS = [
  "SWITCHYARD_AZURE_CLIENT_SECRET",
  "SWITCHYARD_DOPPLER_SERVICE_TOKEN",
  "SWITCHYARD_GITHUB_APP_PRIVATE_KEY",
] as const;

const FORBIDDEN_PLATFORM_SECRET_KEYS = [
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_SECRET",
  "AZURE_PASSWORD",
  "AZURE_USERNAME",
  "DOPPLER_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;

const KNOWN_KEYS = new Set<string>([...SAFETY_KEYS, ...ADMISSION_KEYS]);

export interface SafetyRuntimeConfig {
  readonly azure: {
    readonly imageVersion: string;
    readonly subscriptionId: string;
  };
  readonly artefacts: {
    readonly bootstrapSha256: string;
    readonly functionSha256: string;
    readonly templateSha256: string;
  };
  readonly ledger: {
    readonly accountName: string;
    readonly instanceId: string;
    readonly partitionKey: "control-v10";
    readonly schemaVersion: 10;
    readonly tableName: string;
  };
  readonly managedIdentityClientId: string;
  readonly poisonQueue: string;
  readonly provisioningQueue: string;
  readonly runnerSubnetId: string;
  readonly runtimeInstanceId: string;
}

export interface AdmissionRuntimeConfig {
  readonly checkRunAppSlug: string;
  readonly costs: {
    readonly azureLarge: number;
    readonly azureStandard: number;
    readonly blacksmithLarge: number;
    readonly blacksmithStandard: number;
  };
  readonly doppler: {
    readonly config: string;
    readonly githubPrivateKeyName: string;
    readonly oidcAudience: string;
    readonly project: string;
  };
  readonly entra: {
    readonly ancillaryClaimsJson: string;
    readonly apiAudience: string;
    readonly clientApplicationId: string;
    readonly dedicatedRole: string;
    readonly expectedAuthenticationType: string;
    readonly expectedIdentityType: string;
    readonly expectedIssuer: string;
    readonly expectedNameClaimType: string;
    readonly securityClaimsJson: string;
    readonly tenantId: string;
    readonly tokenVersion: "1.0" | "2.0";
  };
  readonly github: {
    readonly appClientId: string;
    readonly appInstallationId: string;
    readonly appSlug: string;
    readonly actorLogin: string;
    readonly organisation: string;
    readonly organisationId: string;
    readonly proofAudience: string;
    readonly reusableWorkflowSha: string;
    readonly runnerGroupId: number;
    readonly switchyardRepositoryId: string;
  };
}

export function parseSafetyRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): SafetyRuntimeConfig {
  rejectUnknownOrSecretSwitchyardKeys(environment);
  const schemaVersion = positiveInteger(required(environment, "SWITCHYARD_LEDGER_SCHEMA_VERSION"));
  if (schemaVersion !== CONTROL_LEDGER_SCHEMA_VERSION || schemaVersion !== 10) {
    throw new TypeError("ledger schema must be exactly 10");
  }
  const partitionKey = required(environment, "SWITCHYARD_LEDGER_PARTITION_KEY");
  if (partitionKey !== "control-v10") throw new TypeError("ledger partition must be control-v10");
  const subscriptionId = uuid(required(environment, "SWITCHYARD_AZURE_SUBSCRIPTION_ID"));
  return Object.freeze({
    azure: Object.freeze({
      imageVersion: exactImageVersion(required(environment, "SWITCHYARD_AZURE_IMAGE_VERSION")),
      subscriptionId,
    }),
    artefacts: Object.freeze({
      bootstrapSha256: sha256(required(environment, "SWITCHYARD_BOOTSTRAP_SHA256")),
      functionSha256: sha256(required(environment, "SWITCHYARD_FUNCTION_ARTIFACT_SHA256")),
      templateSha256: sha256(required(environment, "SWITCHYARD_TEMPLATE_SHA256")),
    }),
    ledger: Object.freeze({
      accountName: storageAccount(required(environment, "SWITCHYARD_LEDGER_ACCOUNT_NAME")),
      instanceId: bounded(required(environment, "SWITCHYARD_LEDGER_INSTANCE_ID"), 128),
      partitionKey,
      schemaVersion: 10,
      tableName: tableName(required(environment, "SWITCHYARD_LEDGER_TABLE_NAME")),
    }),
    managedIdentityClientId: uuid(required(environment, "SWITCHYARD_MANAGED_IDENTITY_CLIENT_ID")),
    poisonQueue: queueName(required(environment, "SWITCHYARD_PROVISIONING_POISON_QUEUE")),
    provisioningQueue: queueName(required(environment, "SWITCHYARD_PROVISIONING_QUEUE")),
    runnerSubnetId: exactSubnet(
      required(environment, "SWITCHYARD_RUNNER_SUBNET_ID"),
      subscriptionId,
    ),
    runtimeInstanceId: bounded(required(environment, "SWITCHYARD_RUNTIME_INSTANCE_ID"), 90),
  });
}

/** Admission is deliberately parsed separately so its failure cannot stop cleanup. */
export function parseAdmissionRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): AdmissionRuntimeConfig {
  rejectUnknownOrSecretSwitchyardKeys(environment);
  return Object.freeze({
    checkRunAppSlug: slug(required(environment, "SWITCHYARD_CHECK_RUN_APP_SLUG")),
    costs: Object.freeze({
      azureLarge: positiveInteger(required(environment, "SWITCHYARD_AZURE_LARGE_COST_CENTS")),
      azureStandard: positiveInteger(required(environment, "SWITCHYARD_AZURE_STANDARD_COST_CENTS")),
      blacksmithLarge: positiveInteger(
        required(environment, "SWITCHYARD_BLACKSMITH_LARGE_COST_CENTS"),
      ),
      blacksmithStandard: positiveInteger(
        required(environment, "SWITCHYARD_BLACKSMITH_STANDARD_COST_CENTS"),
      ),
    }),
    doppler: Object.freeze({
      config: bounded(required(environment, "SWITCHYARD_DOPPLER_CONFIG"), 128),
      githubPrivateKeyName: envName(
        required(environment, "SWITCHYARD_DOPPLER_GITHUB_PRIVATE_KEY_NAME"),
      ),
      oidcAudience: bounded(required(environment, "SWITCHYARD_DOPPLER_OIDC_AUDIENCE"), 512),
      project: bounded(required(environment, "SWITCHYARD_DOPPLER_PROJECT"), 128),
    }),
    entra: Object.freeze({
      ancillaryClaimsJson: strictJsonObject(
        required(environment, "SWITCHYARD_ENTRA_ANCILLARY_CLAIMS_JSON"),
      ),
      apiAudience: bounded(required(environment, "SWITCHYARD_ENTRA_API_AUDIENCE"), 512),
      clientApplicationId: uuid(required(environment, "SWITCHYARD_ENTRA_CLIENT_APPLICATION_ID")),
      dedicatedRole: bounded(required(environment, "SWITCHYARD_ENTRA_DEDICATED_ROLE"), 128),
      expectedAuthenticationType: bounded(
        required(environment, "SWITCHYARD_ENTRA_EXPECTED_AUTHENTICATION_TYPE"),
        128,
      ),
      expectedIdentityType: bounded(
        required(environment, "SWITCHYARD_ENTRA_EXPECTED_IDENTITY_TYPE"),
        128,
      ),
      expectedIssuer: bounded(required(environment, "SWITCHYARD_ENTRA_EXPECTED_ISSUER"), 512),
      expectedNameClaimType: bounded(
        required(environment, "SWITCHYARD_ENTRA_EXPECTED_NAME_CLAIM_TYPE"),
        512,
      ),
      securityClaimsJson: strictJsonObject(
        required(environment, "SWITCHYARD_ENTRA_SECURITY_CLAIMS_JSON"),
      ),
      tenantId: uuid(required(environment, "SWITCHYARD_ENTRA_TENANT_ID")),
      tokenVersion: tokenVersion(required(environment, "SWITCHYARD_ENTRA_TOKEN_VERSION")),
    }),
    github: Object.freeze({
      appClientId: bounded(required(environment, "SWITCHYARD_GITHUB_APP_CLIENT_ID"), 128),
      actorLogin: bounded(required(environment, "SWITCHYARD_GITHUB_ACTOR_LOGIN"), 100),
      appInstallationId: positiveDecimal(
        required(environment, "SWITCHYARD_GITHUB_APP_INSTALLATION_ID"),
      ),
      appSlug: slug(required(environment, "SWITCHYARD_GITHUB_APP_SLUG")),
      organisation: slug(required(environment, "SWITCHYARD_GITHUB_ORGANISATION")),
      organisationId: positiveDecimal(required(environment, "SWITCHYARD_GITHUB_ORGANISATION_ID")),
      proofAudience: bounded(required(environment, "SWITCHYARD_GITHUB_PROOF_AUDIENCE"), 512),
      reusableWorkflowSha: fullSha(
        required(environment, "SWITCHYARD_GITHUB_REUSABLE_WORKFLOW_SHA"),
      ),
      runnerGroupId: positiveInteger(required(environment, "SWITCHYARD_GITHUB_RUNNER_GROUP_ID")),
      switchyardRepositoryId: positiveDecimal(
        required(environment, "SWITCHYARD_GITHUB_SWITCHYARD_REPOSITORY_ID"),
      ),
    }),
  });
}

function rejectUnknownOrSecretSwitchyardKeys(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  for (const key of FORBIDDEN_PLATFORM_SECRET_KEYS) {
    if (typeof environment[key] === "string" && environment[key]?.length !== 0) {
      throw new TypeError("secret-bearing runtime environment variables are forbidden");
    }
  }
  for (const key of Object.keys(environment)) {
    if (!key.startsWith("SWITCHYARD_")) continue;
    if ((FORBIDDEN_SECRET_KEYS as readonly string[]).includes(key)) {
      throw new TypeError("secret-bearing Switchyard environment variables are forbidden");
    }
    if (!KNOWN_KEYS.has(key)) throw new TypeError("unknown Switchyard environment variable");
  }
}

function required(environment: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new TypeError(`${key} is required`);
  }
  return value;
}

function exactImageVersion(value: string): string {
  if (value.toLowerCase() === "latest") throw new TypeError("moving Azure image is forbidden");
  return bounded(value, 256);
}

function strictJsonObject(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("claim mapping JSON is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("claim mapping JSON must be an object");
  }
  return value;
}

function exactSubnet(value: string, subscriptionId: string): string {
  if (
    !value.startsWith(`/subscriptions/${subscriptionId}/resourceGroups/`) ||
    !/\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+\/subnets\/[^/]+$/.test(value)
  ) {
    throw new TypeError("runner subnet is invalid");
  }
  return value;
}

function storageAccount(value: string): string {
  if (!/^[a-z0-9]{3,24}$/.test(value)) throw new TypeError("storage account name is invalid");
  return value;
}

function tableName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(value)) throw new TypeError("table name is invalid");
  return value;
}

function queueName(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(value) || value.includes("--")) {
    throw new TypeError("queue name is invalid");
  }
  return value;
}

function slug(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(value)) throw new TypeError("slug is invalid");
  return value;
}

function envName(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) throw new TypeError("secret name is invalid");
  return value;
}

function sha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError("sha256 digest is invalid");
  return value;
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError("UUID is invalid");
  }
  return value.toLowerCase();
}

function positiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new TypeError("positive integer is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError("positive integer is invalid");
  return parsed;
}

function positiveDecimal(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value)) throw new TypeError("positive decimal is invalid");
  return value;
}

function tokenVersion(value: string): "1.0" | "2.0" {
  if (value !== "1.0" && value !== "2.0") throw new TypeError("token version is invalid");
  return value;
}

function fullSha(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new TypeError("commit SHA is invalid");
  return value;
}

function bounded(value: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum) throw new TypeError("value is out of bounds");
  return value;
}
