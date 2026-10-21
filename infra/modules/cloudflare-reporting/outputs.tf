output "database" {
  description = "Non-secret D1 database identifiers."
  value = {
    id           = cloudflare_d1_database.reporting.id
    jurisdiction = cloudflare_d1_database.reporting.jurisdiction
    name         = cloudflare_d1_database.reporting.name
  }
}

output "worker" {
  description = "Staged Worker and Access identifiers, or null until deploy_worker is enabled."
  value = var.deploy_worker ? {
    script_name           = cloudflare_worker.reporting[0].name
    worker_id             = cloudflare_worker.reporting[0].id
    version_id            = cloudflare_worker_version.reporting[0].id
    deployment_id         = cloudflare_workers_deployment.reporting[0].id
    access_application_id = cloudflare_zero_trust_access_application.reporting[0].id
    access_audience       = cloudflare_zero_trust_access_application.reporting[0].aud
    hostname              = local.worker_hostname
    published             = var.publish_worker
    d1_schema_revision    = var.d1_schema_revision
  } : null
}
