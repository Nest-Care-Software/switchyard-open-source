variable "account_id" {
  description = "Cloudflare account ID."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{32}$", var.account_id))
    error_message = "account_id must be a 32-character Cloudflare account ID."
  }
}

variable "database_name" {
  description = "EU-jurisdiction D1 reporting database name."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.database_name))
    error_message = "database_name must be 1 to 64 letters, digits, underscores or hyphens."
  }
}

variable "deploy_worker" {
  description = "Create the Access application, unpublished Worker, reviewed version, D1 binding and cron only after the artifact and D1 schema exist."
  type        = bool
  default     = false
}

variable "publish_worker" {
  description = "Enable the Worker's workers.dev endpoint only in a separate stage after Access protection has been established and verified."
  type        = bool
  default     = false
}

variable "access_protection_verified" {
  description = "Explicit non-secret attestation that the Access application and service-token policy were established and verified in an earlier authorised stage."
  type        = bool
  default     = false
}

variable "worker_script_name" {
  description = "Cloudflare Worker script name."
  type        = string
  default     = "switchyard-reporting"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.worker_script_name))
    error_message = "worker_script_name must be a 1 to 63 character lowercase DNS label."
  }
}

variable "worker_artifact_path" {
  description = "Path to a built, secret-free JavaScript module. Required when deploy_worker is true."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.worker_artifact_path == null || can(regex("\\.(mjs|js)$", var.worker_artifact_path))
    error_message = "worker_artifact_path must be null or a .js/.mjs file path."
  }
}

variable "worker_artifact_sha256" {
  description = "Expected lowercase SHA-256 of the built Worker artifact. Required when deploy_worker is true."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.worker_artifact_sha256 == null || can(regex("^[0-9a-f]{64}$", var.worker_artifact_sha256))
    error_message = "worker_artifact_sha256 must be null or a lowercase SHA-256 digest."
  }
}

variable "d1_schema_revision" {
  description = "Reviewed application migration revision already applied to D1. Required when deploy_worker is true; OpenTofu does not execute SQL."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.d1_schema_revision == null || can(regex("^[0-9a-f]{7,64}$", var.d1_schema_revision))
    error_message = "d1_schema_revision must be null or a 7 to 64 character lowercase hexadecimal revision."
  }
}

variable "workers_dev_account_subdomain" {
  description = "Cloudflare account workers.dev subdomain. The protected hostname is derived from this value and worker_script_name."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.workers_dev_account_subdomain == null || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.workers_dev_account_subdomain))
    error_message = "workers_dev_account_subdomain must be null or a 1 to 63 character lowercase DNS label."
  }
}

variable "access_service_token_id" {
  description = "Non-secret ID of the existing Cloudflare Access service token whose secret remains in Doppler. Required when deploy_worker is true."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.access_service_token_id == null || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.access_service_token_id))
    error_message = "access_service_token_id must be null or a UUID."
  }
}

variable "access_application_name" {
  description = "Cloudflare Access application name."
  type        = string
  default     = "Switchyard reporting API"
}

variable "compatibility_date" {
  description = "Pinned Cloudflare Worker compatibility date."
  type        = string
  default     = "2026-08-01"

  validation {
    condition     = can(regex("^20[0-9]{2}-(0[1-9]|1[0-2])-([0-2][0-9]|3[0-1])$", var.compatibility_date))
    error_message = "compatibility_date must use YYYY-MM-DD format."
  }
}
