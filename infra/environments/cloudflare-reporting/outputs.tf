output "reporting" {
  description = "Non-secret Cloudflare reporting foundation identifiers."
  value = {
    database = module.reporting.database
    worker   = module.reporting.worker
  }
}
