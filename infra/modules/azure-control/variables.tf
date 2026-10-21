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
    error_message = "tenant_id must be a Microsoft Entra tenant UUID."
  }
}

variable "location" {
  description = "Azure pilot region. V1 is deliberately fixed to UK South."
  type        = string
  default     = "uksouth"

  validation {
    condition     = lower(var.location) == "uksouth"
    error_message = "The Azure pilot may only use UK South."
  }
}

variable "control_resource_group_name" {
  description = "Long-lived control-plane resource group name."
  type        = string

  validation {
    condition     = length(var.control_resource_group_name) >= 1 && length(var.control_resource_group_name) <= 90 && can(regex("^[A-Za-z0-9._()\\-]+$", var.control_resource_group_name))
    error_message = "control_resource_group_name must be a valid 1 to 90 character Azure resource group name."
  }
}

variable "storage_account_name" {
  description = "Globally unique control storage account name."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.storage_account_name))
    error_message = "storage_account_name must contain 3 to 24 lowercase letters or digits."
  }
}

variable "key_vault_name" {
  description = "Globally unique Key Vault name. No secret is created by this module."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$", var.key_vault_name))
    error_message = "key_vault_name must be a valid 3 to 24 character Key Vault name."
  }
}

variable "function_app_name" {
  description = "Globally unique public HTTPS Function App name."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$", var.function_app_name))
    error_message = "function_app_name must be 2 to 60 lowercase letters, digits or hyphens and may not start or end with a hyphen."
  }
}

variable "service_plan_name" {
  description = "Dedicated Linux App Service plan name."
  type        = string
}

variable "managed_identity_name" {
  description = "User-assigned identity used by the Function host and controller runtime."
  type        = string
}

variable "ledger_bootstrap_managed_identity_name" {
  description = "User-assigned identity reserved exclusively for the one-time ledger bootstrap artefact."
  type        = string
}

variable "log_analytics_workspace_name" {
  description = "Log Analytics workspace name."
  type        = string
}

variable "application_insights_name" {
  description = "Application Insights component name."
  type        = string
}

variable "action_group_name" {
  description = "Azure Monitor action group resource name."
  type        = string
}

variable "action_group_short_name" {
  description = "Azure Monitor action group short name."
  type        = string
  default     = "switchyard"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,12}$", var.action_group_short_name))
    error_message = "action_group_short_name must be 1 to 12 letters, digits, underscores or hyphens."
  }
}

variable "alert_email" {
  description = "Non-secret owner email address for Azure Monitor alerts."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be a syntactically valid email address."
  }
}

variable "virtual_network_name" {
  description = "Shared runner virtual network name."
  type        = string
}

variable "runner_subnet_name" {
  description = "Shared subnet used only by controller-created allocation NICs."
  type        = string
}

variable "nat_gateway_name" {
  description = "Shared runner outbound NAT gateway name."
  type        = string
}

variable "nat_public_ip_name" {
  description = "Static public IP name for the shared outbound NAT gateway."
  type        = string
}

variable "virtual_network_address_space" {
  description = "Address space for the isolated runner virtual network."
  type        = list(string)
  default     = ["10.64.0.0/16"]

  validation {
    condition     = length(var.virtual_network_address_space) == 1 && can(cidrnetmask(var.virtual_network_address_space[0]))
    error_message = "virtual_network_address_space must contain exactly one valid CIDR."
  }
}

variable "runner_subnet_prefixes" {
  description = "Address prefixes for the shared runner subnet."
  type        = list(string)
  default     = ["10.64.1.0/24"]

  validation {
    condition     = length(var.runner_subnet_prefixes) == 1 && can(cidrnetmask(var.runner_subnet_prefixes[0]))
    error_message = "runner_subnet_prefixes must contain exactly one valid CIDR."
  }
}

variable "function_auth_client_id" {
  description = "Client ID of the existing Entra app registration exposed by the Function API."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.function_auth_client_id))
    error_message = "function_auth_client_id must be a UUID."
  }
}

variable "function_auth_audience" {
  description = "Audience accepted by Function App Authentication. Defaults to api://<function_auth_client_id>."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.function_auth_audience == null || can(regex("^api://[^[:space:]]+$", var.function_auth_audience))
    error_message = "function_auth_audience must be null or an api:// URI."
  }
}

variable "github_workload_client_id" {
  description = "Client ID of the existing Entra workload identity used by approved GitHub allocation jobs."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.github_workload_client_id))
    error_message = "github_workload_client_id must be a UUID."
  }
}

variable "runner_image_version" {
  description = "Exact Canonical Ubuntu 24.04 LTS image version pinned for controller-owned allocations."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.runner_image_version))
    error_message = "runner_image_version must be an exact three-part Marketplace version, never latest."
  }
}

variable "deployment_principal_object_id" {
  description = "Object ID of the existing identity used for reviewed infrastructure deployments."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.deployment_principal_object_id))
    error_message = "deployment_principal_object_id must be a UUID."
  }
}

variable "owner_principal_object_id" {
  description = "the owner's Entra object ID, used for read-only diagnostic access."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.owner_principal_object_id))
    error_message = "owner_principal_object_id must be a UUID."
  }
}

variable "owner_recovery_principal_object_id" {
  description = "Object ID of the separately approved owner identity for the dry-run-first allocation recovery command."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.owner_recovery_principal_object_id))
    error_message = "owner_recovery_principal_object_id must be a UUID."
  }
}

variable "allocation_resource_group_prefix" {
  description = "Required prefix for controller-owned allocation resource groups. OpenTofu creates none of them."
  type        = string
  default     = "rg-switchyard-allocation-"

  validation {
    condition     = can(regex("^[a-z0-9-]{3,50}-$", var.allocation_resource_group_prefix))
    error_message = "allocation_resource_group_prefix must be 3 to 50 lowercase letters, digits or hyphens and end in a hyphen."
  }
}

variable "doppler_bootstrap_enabled" {
  description = "Whether the documented conditional Doppler bootstrap-token path is enabled. This module never creates the secret value."
  type        = bool
  default     = false
}

variable "doppler_bootstrap_secret_name" {
  description = "Name reserved for the one conditional Doppler bootstrap token in Key Vault."
  type        = string
  default     = "doppler-bootstrap-token"

  validation {
    condition     = can(regex("^[A-Za-z0-9-]{1,127}$", var.doppler_bootstrap_secret_name))
    error_message = "doppler_bootstrap_secret_name must be a valid Key Vault secret name."
  }
}

variable "ledger_table_name" {
  description = "Single authoritative Azure Table containing the ledger foundation, allocations, ordered attempts, generations and allowance history."
  type        = string
  default     = "SwitchyardLedger"

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9]{2,62}$", var.ledger_table_name))
    error_message = "ledger_table_name must be 3 to 63 alphanumeric characters and start with a letter."
  }
}

variable "ledger_partition_key" {
  description = "Sole Azure Table partition key for the schema-10 authoritative ledger."
  type        = string
  default     = "control-v10"

  validation {
    condition     = var.ledger_partition_key == "control-v10"
    error_message = "ledger_partition_key must match the schema-10 runtime partition key control-v10."
  }
}

variable "ledger_instance_id" {
  description = "Externally chosen immutable UUID identifying this destructive ledger-table installation."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", var.ledger_instance_id))
    error_message = "ledger_instance_id must be a lowercase RFC 4122 UUID."
  }
}

variable "ledger_schema_version" {
  description = "Persisted authoritative ledger schema expected by both bootstrap and runtime."
  type        = number
  default     = 10

  validation {
    condition     = var.ledger_schema_version == 10
    error_message = "ledger_schema_version must match the supported runtime schema version 10."
  }
}

variable "queue_names" {
  description = "Provisioning, provisioning poison, and dormant best-effort reporting queue names."
  type = object({
    provisioning        = string
    provisioning_poison = string
    reporting           = string
  })
  default = {
    provisioning        = "provision-allocations"
    provisioning_poison = "provision-allocations-poison"
    reporting           = "report-completed-allocations"
  }

  validation {
    condition     = alltrue([for name in values(var.queue_names) : can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", name)) && !strcontains(name, "--")])
    error_message = "Azure Queue names must be 3 to 63 lowercase letters, digits or single interior hyphens."
  }
}

variable "function_package_deployment_enabled" {
  description = "Deploy the exact reviewed Function ZIP only when its separate pre-apply approval and digest are supplied."
  type        = bool
  default     = false
}

variable "function_package_path" {
  description = "Local path to the deterministic Function ZIP. It is unused while package deployment is disabled."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.function_package_path == null || can(regex("\\.zip$", var.function_package_path))
    error_message = "function_package_path must be null or a .zip file."
  }
}

variable "function_package_sha256" {
  description = "Reviewed lowercase SHA-256 of the deterministic Function ZIP. It is unused while package deployment is disabled."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.function_package_sha256 == null || can(regex("^[0-9a-f]{64}$", var.function_package_sha256))
    error_message = "function_package_sha256 must be null or a lowercase SHA-256 digest."
  }
}

variable "admission_runtime_settings" {
  description = "Complete reviewed non-secret admission configuration. An empty map keeps production admission disabled."
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
      alltrue([
        for value in values(var.admission_runtime_settings) :
        length(trimspace(value)) >= 1 &&
        length(value) <= 4096 &&
        !can(regex("(?i)(-----BEGIN|gh[opusr]_[A-Za-z0-9_]{20,}|dp\\.st\\.)", value))
      ])
    )
    error_message = "admission_runtime_settings must be empty or contain the complete exact non-secret admission allowlist with bounded non-empty values and no credential-shaped content."
  }
}

variable "diagnostics_container_name" {
  description = "Private blob container for seven-day runner diagnostics."
  type        = string
  default     = "runner-diagnostics"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.diagnostics_container_name)) && !strcontains(var.diagnostics_container_name, "--")
    error_message = "diagnostics_container_name must be a valid Azure blob container name."
  }
}

variable "tags" {
  description = "Additional non-secret tags for long-lived Azure resources. Mandatory Switchyard tags take precedence."
  type        = map(string)
  default     = {}
}
