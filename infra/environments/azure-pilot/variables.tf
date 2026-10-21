variable "dedicated_subscription_confirmed" {
  description = "Explicit confirmation that the target subscription is dedicated to Switchyard and contains no unrelated resources."
  type        = bool

  validation {
    condition     = var.dedicated_subscription_confirmed
    error_message = "The Azure pilot must use a subscription dedicated to Switchyard."
  }
}

variable "subscription_id" {
  description = "Dedicated Switchyard Azure subscription ID."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be an Azure subscription UUID."
  }
}

variable "tenant_id" {
  description = "Microsoft Entra tenant ID."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.tenant_id))
    error_message = "tenant_id must be a UUID."
  }
}

variable "deployment_principal_object_id" {
  description = "Object ID of the existing identity used for reviewed OpenTofu deployments."
  type        = string
}

variable "owner_principal_object_id" {
  description = "the owner's Entra object ID for read-only diagnostic access."
  type        = string
}

variable "owner_recovery_principal_object_id" {
  description = "Object ID of the separately approved owner identity for allocation recovery."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.owner_recovery_principal_object_id))
    error_message = "owner_recovery_principal_object_id must be a UUID."
  }
}

variable "function_auth_client_id" {
  description = "Client ID of the existing Entra app registration exposed by the Function API."
  type        = string
}

variable "github_workload_client_id" {
  description = "Client ID of the existing Entra workload identity used by approved GitHub allocation jobs."
  type        = string
}

variable "runner_image_version" {
  description = "Exact Canonical Ubuntu 24.04 LTS image version resolved in UK South. There is deliberately no default."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.runner_image_version))
    error_message = "runner_image_version must be an exact three-part Marketplace version, never latest."
  }
}

variable "alert_email" {
  description = "Non-secret owner email for Azure Monitor alerts."
  type        = string
}

variable "storage_account_name" {
  description = "Globally unique control storage account name."
  type        = string
}

variable "key_vault_name" {
  description = "Globally unique Key Vault name."
  type        = string
}

variable "function_app_name" {
  description = "Globally unique Function App name."
  type        = string
}

variable "ledger_instance_id" {
  description = "Externally chosen immutable lowercase UUID for this complete ledger-table installation."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", var.ledger_instance_id))
    error_message = "ledger_instance_id must be a lowercase RFC 4122 UUID."
  }
}

variable "ledger_partition_key" {
  description = "Expected sole partition for the schema-10 authoritative ledger."
  type        = string
  default     = "control-v10"

  validation {
    condition     = var.ledger_partition_key == "control-v10"
    error_message = "ledger_partition_key must be control-v10."
  }
}

variable "ledger_schema_version" {
  description = "Expected fresh-bootstrap authoritative ledger schema."
  type        = number
  default     = 10

  validation {
    condition     = var.ledger_schema_version == 10
    error_message = "ledger_schema_version must be 10."
  }
}

variable "doppler_bootstrap_enabled" {
  description = "Enable only after the managed-identity-to-Doppler live test has failed and the owner approves the documented exception."
  type        = bool
  default     = false
}

variable "function_package_deployment_enabled" {
  description = "Deploy the exact reviewed Function ZIP after the separate pre-apply approval."
  type        = bool
  default     = false
}

variable "function_package_path" {
  description = "Local path to the deterministic Function ZIP. Leave null while package deployment is disabled."
  type        = string
  default     = null
  nullable    = true
}

variable "function_package_sha256" {
  description = "Reviewed lowercase SHA-256 of the deterministic Function ZIP. Leave null while package deployment is disabled."
  type        = string
  default     = null
  nullable    = true
}

variable "admission_runtime_settings" {
  description = "Complete reviewed non-secret admission configuration. Leave empty to keep production admission disabled."
  type        = map(string)
  default     = {}

  validation {
    condition = length(var.admission_runtime_settings) == 0 || (
      toset(keys(var.admission_runtime_settings)) == toset([
        "SWITCHYARD_AZURE_LARGE_COST_CENTS",
        "SWITCHYARD_AZURE_STANDARD_COST_CENTS",
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
      ]) &&
      alltrue([for value in values(var.admission_runtime_settings) : length(trimspace(value)) >= 1 && length(value) <= 4096])
    )
    error_message = "admission_runtime_settings must be empty or contain every exact non-secret admission setting with a bounded non-empty value."
  }
}

variable "tags" {
  description = "Additional non-secret Azure tags."
  type        = map(string)
  default     = {}
}
