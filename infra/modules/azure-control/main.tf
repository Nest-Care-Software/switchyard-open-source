locals {
  subscription_scope = "/subscriptions/${var.subscription_id}"
  function_audience  = coalesce(var.function_auth_audience, "api://${var.function_auth_client_id}")

  mandatory_tags = {
    environment = "pilot"
    managed-by  = "opentofu"
    system      = "switchyard"
  }

  tags = merge(var.tags, local.mandatory_tags)

  storage_data_roles = {
    blob_owner        = "b7e6dc6d-f1e8-4753-8033-0f276bb0955b"
    queue_contributor = "974c5e8b-45b9-4653-ba55-5f855dd0fb88"
  }
}

resource "azurerm_resource_group" "control" {
  name     = var.control_resource_group_name
  location = var.location
  tags     = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_management_lock" "control" {
  name       = "switchyard-control-cannot-delete"
  scope      = azurerm_resource_group.control.id
  lock_level = "CanNotDelete"
  notes      = "Protects the long-lived Switchyard control foundation from deletion."

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_user_assigned_identity" "controller" {
  name                = var.managed_identity_name
  location            = azurerm_resource_group.control.location
  resource_group_name = azurerm_resource_group.control.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "ledger_bootstrap" {
  name                = var.ledger_bootstrap_managed_identity_name
  location            = azurerm_resource_group.control.location
  resource_group_name = azurerm_resource_group.control.name
  tags                = local.tags
}
