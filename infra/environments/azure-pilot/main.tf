module "control" {
  source = "../../modules/azure-control"

  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id

  control_resource_group_name            = "rg-switchyard-example-control"
  storage_account_name                   = var.storage_account_name
  key_vault_name                         = var.key_vault_name
  function_app_name                      = var.function_app_name
  service_plan_name                      = "asp-switchyard-control-uksouth"
  managed_identity_name                  = "id-switchyard-controller-uksouth"
  ledger_bootstrap_managed_identity_name = "id-switchyard-ledger-bootstrap-uksouth"

  ledger_instance_id    = var.ledger_instance_id
  ledger_partition_key  = var.ledger_partition_key
  ledger_schema_version = var.ledger_schema_version

  log_analytics_workspace_name = "log-switchyard-control-uksouth"
  application_insights_name    = "appi-switchyard-control-uksouth"
  action_group_name            = "ag-switchyard-owner"
  alert_email                  = var.alert_email

  virtual_network_name = "vnet-switchyard-runners-uksouth"
  runner_subnet_name   = "snet-switchyard-runners"
  nat_gateway_name     = "nat-switchyard-runners-uksouth"
  nat_public_ip_name   = "pip-switchyard-runner-egress-uksouth"

  function_auth_client_id             = var.function_auth_client_id
  github_workload_client_id           = var.github_workload_client_id
  runner_image_version                = var.runner_image_version
  deployment_principal_object_id      = var.deployment_principal_object_id
  owner_principal_object_id           = var.owner_principal_object_id
  owner_recovery_principal_object_id  = var.owner_recovery_principal_object_id
  doppler_bootstrap_enabled           = var.doppler_bootstrap_enabled
  function_package_deployment_enabled = var.function_package_deployment_enabled
  function_package_path               = var.function_package_path
  function_package_sha256             = var.function_package_sha256
  admission_runtime_settings          = var.admission_runtime_settings
  tags                                = var.tags
}
