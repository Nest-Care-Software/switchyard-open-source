resource "cloudflare_d1_database" "reporting" {
  account_id   = var.account_id
  name         = var.database_name
  jurisdiction = "eu"

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  worker_hostname = var.workers_dev_account_subdomain == null ? null : "${var.worker_script_name}.${var.workers_dev_account_subdomain}.workers.dev"
}

resource "terraform_data" "worker_artifact_gate" {
  input = {
    d1_schema_revision     = var.d1_schema_revision
    worker_artifact_path   = var.worker_artifact_path
    worker_artifact_sha256 = var.worker_artifact_sha256
  }

  lifecycle {
    precondition {
      condition = (
        !var.deploy_worker || (
          var.worker_artifact_path != null &&
          var.worker_artifact_sha256 != null &&
          var.d1_schema_revision != null &&
          var.workers_dev_account_subdomain != null &&
          var.access_service_token_id != null
        )
      )
      error_message = "Worker deployment is closed until the artifact path/hash, applied D1 schema revision, account workers.dev subdomain and non-secret Access token ID are all supplied."
    }

    precondition {
      condition     = !var.deploy_worker || (var.worker_artifact_path == null ? false : fileexists(var.worker_artifact_path))
      error_message = "worker_artifact_path does not exist. Build the reviewed Worker before enabling deployment."
    }

    precondition {
      condition     = !var.deploy_worker || (var.worker_artifact_path == null || var.worker_artifact_sha256 == null ? false : filesha256(var.worker_artifact_path) == var.worker_artifact_sha256)
      error_message = "worker_artifact_sha256 does not match the built Worker artifact."
    }

    precondition {
      condition     = !var.publish_worker || (var.deploy_worker && var.access_protection_verified)
      error_message = "Worker publication is closed until the disabled endpoint, Access application and policy have been established and independently verified in a prior authorised stage."
    }
  }
}

resource "cloudflare_zero_trust_access_application" "reporting" {
  count = var.deploy_worker ? 1 : 0

  account_id           = var.account_id
  name                 = var.access_application_name
  domain               = local.worker_hostname
  type                 = "self_hosted"
  app_launcher_visible = false
  session_duration     = "1h"
  skip_interstitial    = true

  policies = [
    {
      name       = "Allow Switchyard service token"
      decision   = "non_identity"
      precedence = 1
      include = [
        {
          service_token = {
            token_id = var.access_service_token_id
          }
        }
      ]
    }
  ]

  depends_on = [terraform_data.worker_artifact_gate]
}

resource "cloudflare_worker" "reporting" {
  count = var.deploy_worker ? 1 : 0

  account_id = var.account_id
  name       = var.worker_script_name
  subdomain = {
    enabled          = var.publish_worker
    previews_enabled = false
  }

  depends_on = [cloudflare_zero_trust_access_application.reporting]
}

resource "cloudflare_worker_version" "reporting" {
  count = var.deploy_worker ? 1 : 0

  account_id         = var.account_id
  worker_id          = cloudflare_worker.reporting[0].id
  compatibility_date = var.compatibility_date
  main_module        = "index.js"

  bindings = [
    {
      name        = "REPORTING_DB"
      type        = "d1"
      database_id = cloudflare_d1_database.reporting.id
    }
  ]

  modules = [
    {
      name         = "index.js"
      content_type = "application/javascript+module"
      content_file = var.worker_artifact_path
    }
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.worker_artifact_gate]
  }
}

resource "cloudflare_workers_deployment" "reporting" {
  count = var.deploy_worker ? 1 : 0

  account_id  = var.account_id
  script_name = cloudflare_worker.reporting[0].name
  strategy    = "percentage"
  versions = [
    {
      percentage = 100
      version_id = cloudflare_worker_version.reporting[0].id
    }
  ]
}

resource "cloudflare_workers_cron_trigger" "daily_retention" {
  count = var.deploy_worker ? 1 : 0

  account_id  = var.account_id
  script_name = cloudflare_worker.reporting[0].name
  schedules = [
    {
      cron = "15 2 * * *"
    }
  ]

  depends_on = [cloudflare_workers_deployment.reporting]
}
