resource "azurerm_key_vault" "control" {
  name                = var.key_vault_name
  location            = azurerm_resource_group.control.location
  resource_group_name = azurerm_resource_group.control.name
  tenant_id           = var.tenant_id
  sku_name            = "standard"

  rbac_authorization_enabled      = true
  enabled_for_disk_encryption     = false
  enabled_for_deployment          = false
  enabled_for_template_deployment = false
  public_network_access_enabled   = true
  purge_protection_enabled        = true
  soft_delete_retention_days      = 90

  tags = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "controller_doppler_bootstrap_reader" {
  count = var.doppler_bootstrap_enabled ? 1 : 0

  scope                            = azurerm_key_vault.control.id
  role_definition_id               = "${local.subscription_scope}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6"
  principal_id                     = azurerm_user_assigned_identity.controller.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}
