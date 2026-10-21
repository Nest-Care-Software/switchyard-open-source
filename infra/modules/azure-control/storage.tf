resource "azurerm_storage_account" "control" {
  name                = var.storage_account_name
  resource_group_name = azurerm_resource_group.control.name
  location            = azurerm_resource_group.control.location

  account_kind             = "StorageV2"
  account_tier             = "Standard"
  account_replication_type = "LRS"
  access_tier              = "Hot"

  allow_nested_items_to_be_public   = false
  default_to_oauth_authentication   = true
  https_traffic_only_enabled        = true
  infrastructure_encryption_enabled = true
  min_tls_version                   = "TLS1_2"
  public_network_access_enabled     = true
  shared_access_key_enabled         = false

  blob_properties {
    versioning_enabled = false
  }

  tags = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "controller_storage_data" {
  for_each = local.storage_data_roles

  scope                            = azurerm_storage_account.control.id
  role_definition_id               = "${local.subscription_scope}/providers/Microsoft.Authorization/roleDefinitions/${each.value}"
  principal_id                     = azurerm_user_assigned_identity.controller.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

// AzureRM 5.2.0 reads table ACLs through shared-key authentication even when
// storage_use_azuread is true. Use the ARM management plane so the account can
// remain keyless and the deployment identity needs no Storage data role.
resource "azapi_resource" "authoritative_table" {
  type      = "Microsoft.Storage/storageAccounts/tableServices/tables@2025-06-01"
  parent_id = "${azurerm_storage_account.control.id}/tableServices/default"
  name      = var.ledger_table_name
  body = {
    properties = {
      signedIdentifiers = []
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "ledger_runtime_data" {
  scope                            = azapi_resource.authoritative_table.id
  role_definition_id               = azurerm_role_definition.ledger_runtime.role_definition_resource_id
  principal_id                     = azurerm_user_assigned_identity.controller.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "ledger_bootstrap_data" {
  scope                            = azapi_resource.authoritative_table.id
  role_definition_id               = azurerm_role_definition.ledger_bootstrap.role_definition_resource_id
  principal_id                     = azurerm_user_assigned_identity.ledger_bootstrap.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_storage_queue" "control" {
  for_each = var.queue_names

  name               = each.value
  storage_account_id = azurerm_storage_account.control.id

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "diagnostics" {
  name                  = var.diagnostics_container_name
  storage_account_id    = azurerm_storage_account.control.id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_management_policy" "diagnostics" {
  storage_account_id = azurerm_storage_account.control.id

  rule {
    name    = "delete-runner-diagnostics-after-seven-days"
    enabled = true

    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["${var.diagnostics_container_name}/"]
    }

    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 7
      }
    }
  }

  depends_on = [azurerm_storage_container.diagnostics]
}

resource "azurerm_role_assignment" "owner_diagnostics_reader" {
  scope                            = azurerm_storage_container.diagnostics.id
  role_definition_id               = "${local.subscription_scope}/providers/Microsoft.Authorization/roleDefinitions/2a2b9908-6ea1-4ae2-8e65-a410df84e7d1"
  principal_id                     = var.owner_principal_object_id
  skip_service_principal_aad_check = true
}
