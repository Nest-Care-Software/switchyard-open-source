module "reporting" {
  source = "../../modules/cloudflare-reporting"

  account_id              = var.cloudflare_account_id
  database_name           = "switchyard-reporting-eu"
  worker_script_name      = "switchyard-reporting"
  access_application_name = "Switchyard reporting API"

  deploy_worker                 = var.deploy_worker
  publish_worker                = var.publish_worker
  access_protection_verified    = var.access_protection_verified
  worker_artifact_path          = var.worker_artifact_path
  worker_artifact_sha256        = var.worker_artifact_sha256
  d1_schema_revision            = var.d1_schema_revision
  workers_dev_account_subdomain = var.workers_dev_account_subdomain
  access_service_token_id       = var.access_service_token_id
}
