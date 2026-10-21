output "control_resource_group_id" {
  description = "ID of the long-lived Switchyard control resource group."
  value       = azurerm_resource_group.control.id
}

output "control_resource_group_lock_id" {
  description = "ID of the CanNotDelete lock protecting the long-lived control resource group."
  value       = azurerm_management_lock.control.id
}

output "controller_identity" {
  description = "Non-secret IDs for the controller's user-assigned managed identity."
  value = {
    resource_id  = azurerm_user_assigned_identity.controller.id
    client_id    = azurerm_user_assigned_identity.controller.client_id
    principal_id = azurerm_user_assigned_identity.controller.principal_id
  }
}

output "ledger_bootstrap_identity" {
  description = "Non-secret IDs for the provisioning-only managed identity. It is never attached to the Function App."
  value = {
    resource_id  = azurerm_user_assigned_identity.ledger_bootstrap.id
    client_id    = azurerm_user_assigned_identity.ledger_bootstrap.client_id
    principal_id = azurerm_user_assigned_identity.ledger_bootstrap.principal_id
  }
}

output "authoritative_ledger" {
  description = "Immutable installation evidence and the sole table and partition used by the authoritative ledger."
  value = {
    table_id           = azapi_resource.authoritative_table.id
    table_name         = azapi_resource.authoritative_table.name
    partition_key      = var.ledger_partition_key
    ledger_instance_id = var.ledger_instance_id
    schema_version     = var.ledger_schema_version
  }
}

output "function_api" {
  description = "Authenticated public HTTPS Function endpoint and accepted audience."
  value = {
    hostname = azurerm_linux_function_app.control.default_hostname
    url      = "https://${azurerm_linux_function_app.control.default_hostname}"
    audience = local.function_audience
  }
}

output "storage_account_id" {
  description = "Authoritative control storage account ID."
  value       = azurerm_storage_account.control.id
}

output "runner_network" {
  description = "Shared outbound network values consumed by the controller-owned allocation deployment template. Allocation NSGs are not long-lived outputs."
  value = {
    subnet_id          = azurerm_subnet.runners.id
    outbound_public_ip = azurerm_public_ip.runner_egress.ip_address
  }
}

output "allocation_template_defaults" {
  description = "Non-secret deployment values fixed centrally rather than exposed to workflow callers."
  value = {
    allocation_resource_group_prefix = var.allocation_resource_group_prefix
    location                         = var.location
    runner_image_version             = var.runner_image_version
    runner_subnet_id                 = azurerm_subnet.runners.id
  }
}

output "runtime_role_definition_id" {
  description = "Custom runtime role definition resource ID."
  value       = azurerm_role_definition.runtime.role_definition_resource_id
}

output "ledger_runtime_role_definition_id" {
  description = "Custom runtime-only ledger entity role definition resource ID."
  value       = azurerm_role_definition.ledger_runtime.role_definition_resource_id
}

output "ledger_bootstrap_role_definition_id" {
  description = "Custom provisioning-only ledger bootstrap role definition resource ID."
  value       = azurerm_role_definition.ledger_bootstrap.role_definition_resource_id
}

output "deployment_role_definition_id" {
  description = "Custom foundation deployment role definition resource ID."
  value       = azurerm_role_definition.deployment.role_definition_resource_id
}

output "monitor_action_group_id" {
  description = "Action group hook for safety and cleanup alerts emitted by future controller behaviour."
  value       = azurerm_monitor_action_group.owner.id
}

output "key_vault_uri" {
  description = "Key Vault URI. The vault contains no OpenTofu-managed secret."
  value       = azurerm_key_vault.control.vault_uri
}
