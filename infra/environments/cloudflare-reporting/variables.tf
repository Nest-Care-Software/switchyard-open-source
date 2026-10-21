variable "cloudflare_account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "deploy_worker" {
  description = "Keep false until D1 migrations and a reviewed Worker artifact exist."
  type        = bool
  default     = false
}

variable "publish_worker" {
  description = "Enable workers.dev only in a separate authorised stage after Access has been established and verified."
  type        = bool
  default     = false
}

variable "access_protection_verified" {
  description = "Non-secret attestation that the Access application and policy were verified before publication."
  type        = bool
  default     = false
}

variable "worker_artifact_path" {
  description = "Path to the built, secret-free Worker module."
  type        = string
  default     = null
  nullable    = true
}

variable "worker_artifact_sha256" {
  description = "Expected lowercase SHA-256 of the Worker module."
  type        = string
  default     = null
  nullable    = true
}

variable "d1_schema_revision" {
  description = "Reviewed migration revision already applied to D1 outside OpenTofu."
  type        = string
  default     = null
  nullable    = true
}

variable "workers_dev_account_subdomain" {
  description = "Cloudflare account workers.dev subdomain used to derive the exact Worker hostname."
  type        = string
  default     = null
  nullable    = true
}

variable "access_service_token_id" {
  description = "Non-secret ID of the existing Access service token. Its secret stays in Doppler."
  type        = string
  default     = null
  nullable    = true
}
