resource "azurerm_role_definition" "runtime" {
  name        = "Switchyard allocation runtime"
  scope       = local.subscription_scope
  description = "Creates and reconciles only Switchyard allocation resource groups and their bounded runner resources."

  permissions {
    actions = [
      "Microsoft.Resources/subscriptions/read",
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Resources/subscriptions/resourceGroups/write",
      "Microsoft.Resources/subscriptions/resourceGroups/delete",
      "Microsoft.Resources/deployments/read",
      "Microsoft.Resources/deployments/write",
      "Microsoft.Resources/deployments/delete",
      "Microsoft.Resources/deployments/operations/read",
      "Microsoft.Resources/deployments/operationStatuses/read",
      "Microsoft.Compute/skus/read",
      "Microsoft.Compute/locations/usages/read",
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/write",
      "Microsoft.Compute/virtualMachines/delete",
      "Microsoft.Compute/virtualMachines/instanceView/read",
      "Microsoft.Compute/virtualMachines/deallocate/action",
      "Microsoft.Compute/virtualMachines/runCommands/read",
      "Microsoft.Compute/virtualMachines/runCommands/write",
      "Microsoft.Compute/virtualMachines/runCommands/delete",
      "Microsoft.Compute/disks/read",
      "Microsoft.Compute/disks/write",
      "Microsoft.Compute/disks/delete",
      "Microsoft.ComputeSchedule/locations/virtualMachinesSubmitDeallocate/action",
      "Microsoft.ComputeSchedule/locations/virtualMachinesCancelOperations/action",
      "Microsoft.ComputeSchedule/locations/virtualMachinesGetOperationStatus/action",
      "Microsoft.ComputeSchedule/locations/virtualMachinesGetOperationErrors/action",
      "Microsoft.Network/virtualNetworks/read",
      "Microsoft.Network/virtualNetworks/subnets/read",
      "Microsoft.Network/virtualNetworks/subnets/join/action",
      "Microsoft.Network/networkSecurityGroups/read",
      "Microsoft.Network/networkSecurityGroups/write",
      "Microsoft.Network/networkSecurityGroups/delete",
      "Microsoft.Network/networkSecurityGroups/join/action",
      "Microsoft.Network/networkSecurityGroups/securityRules/read",
      "Microsoft.Network/networkSecurityGroups/securityRules/write",
      "Microsoft.Network/networkSecurityGroups/securityRules/delete",
      "Microsoft.Network/networkInterfaces/read",
      "Microsoft.Network/networkInterfaces/write",
      "Microsoft.Network/networkInterfaces/delete",
      "Microsoft.Network/networkInterfaces/join/action",
      "Microsoft.Network/publicIPAddresses/read",
      "Microsoft.Network/publicIPAddresses/write",
      "Microsoft.Network/publicIPAddresses/delete",
      "Microsoft.Network/publicIPAddresses/join/action"
    ]
  }

  assignable_scopes = [local.subscription_scope]
}

resource "azurerm_role_assignment" "runtime" {
  scope                            = local.subscription_scope
  role_definition_id               = azurerm_role_definition.runtime.role_definition_resource_id
  principal_id                     = azurerm_user_assigned_identity.controller.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_definition" "owner_recovery" {
  name        = "Switchyard owner allocation recovery"
  scope       = local.subscription_scope
  description = "Lets the separately approved owner inspect, deallocate and delete one strictly proved Switchyard allocation without ledger access."

  permissions {
    actions = [
      "Microsoft.Resources/subscriptions/read",
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Resources/subscriptions/resourceGroups/resources/read",
      "Microsoft.Resources/subscriptions/resourceGroups/delete",
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/instanceView/read",
      "Microsoft.Compute/virtualMachines/deallocate/action",
      "Microsoft.Compute/disks/read",
      "Microsoft.Network/networkInterfaces/read",
      "Microsoft.Network/networkSecurityGroups/read",
      "Microsoft.Network/publicIPAddresses/read"
    ]
  }

  assignable_scopes = [local.subscription_scope]
}

resource "azurerm_role_assignment" "owner_recovery" {
  scope              = local.subscription_scope
  role_definition_id = azurerm_role_definition.owner_recovery.role_definition_resource_id
  principal_id       = var.owner_recovery_principal_object_id
  principal_type     = "User"
}

resource "azurerm_role_definition" "ledger_runtime" {
  name        = "Switchyard ledger runtime"
  scope       = local.subscription_scope
  description = "Reads, creates and ETag-updates ordinary authoritative ledger entities without entity deletion."

  permissions {
    data_actions = [
      "Microsoft.Storage/storageAccounts/tableServices/tables/entities/read",
      "Microsoft.Storage/storageAccounts/tableServices/tables/entities/add/action",
      "Microsoft.Storage/storageAccounts/tableServices/tables/entities/update/action"
    ]
  }

  assignable_scopes = [local.subscription_scope]
}

resource "azurerm_role_definition" "ledger_bootstrap" {
  name        = "Switchyard ledger one-time bootstrap"
  scope       = local.subscription_scope
  description = "Exclusively scans an empty ledger table and atomically creates its immutable foundation; it cannot update or delete entities."

  permissions {
    data_actions = [
      "Microsoft.Storage/storageAccounts/tableServices/tables/entities/read",
      "Microsoft.Storage/storageAccounts/tableServices/tables/entities/add/action"
    ]
  }

  assignable_scopes = [local.subscription_scope]
}

resource "azurerm_role_definition" "deployment" {
  name        = "Switchyard foundation deployment"
  scope       = local.subscription_scope
  description = "Maintains Switchyard's long-lived control resource group; it cannot create allocation VMs or change IAM."

  permissions {
    actions = [
      "Microsoft.Resources/subscriptions/read",
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Resources/subscriptions/resourceGroups/write",
      "Microsoft.Authorization/roleDefinitions/read",
      "Microsoft.Authorization/roleAssignments/read",
      "Microsoft.Authorization/locks/read",
      "Microsoft.Authorization/locks/write",
      "Microsoft.Authorization/locks/delete",
      "Microsoft.ManagedIdentity/userAssignedIdentities/read",
      "Microsoft.ManagedIdentity/userAssignedIdentities/write",
      "Microsoft.ManagedIdentity/userAssignedIdentities/delete",
      "Microsoft.ManagedIdentity/userAssignedIdentities/assign/action",
      "Microsoft.Storage/storageAccounts/read",
      "Microsoft.Storage/storageAccounts/write",
      "Microsoft.Storage/storageAccounts/delete",
      "Microsoft.Storage/storageAccounts/managementPolicies/read",
      "Microsoft.Storage/storageAccounts/managementPolicies/write",
      "Microsoft.Storage/storageAccounts/managementPolicies/delete",
      "Microsoft.Storage/storageAccounts/blobServices/read",
      "Microsoft.Storage/storageAccounts/blobServices/write",
      "Microsoft.Storage/storageAccounts/blobServices/containers/read",
      "Microsoft.Storage/storageAccounts/blobServices/containers/write",
      "Microsoft.Storage/storageAccounts/blobServices/containers/delete",
      "Microsoft.Storage/storageAccounts/queueServices/read",
      "Microsoft.Storage/storageAccounts/queueServices/queues/read",
      "Microsoft.Storage/storageAccounts/queueServices/queues/write",
      "Microsoft.Storage/storageAccounts/queueServices/queues/delete",
      "Microsoft.Storage/storageAccounts/tableServices/read",
      "Microsoft.Storage/storageAccounts/tableServices/tables/read",
      "Microsoft.Storage/storageAccounts/tableServices/tables/write",
      "Microsoft.Storage/storageAccounts/tableServices/tables/delete",
      "Microsoft.KeyVault/vaults/read",
      "Microsoft.KeyVault/vaults/write",
      "Microsoft.KeyVault/vaults/delete",
      "Microsoft.Web/serverfarms/read",
      "Microsoft.Web/serverfarms/write",
      "Microsoft.Web/serverfarms/delete",
      "Microsoft.Web/sites/read",
      "Microsoft.Web/sites/write",
      "Microsoft.Web/sites/delete",
      "Microsoft.Web/sites/config/read",
      "Microsoft.Web/sites/config/write",
      "Microsoft.Web/sites/config/list/action",
      "Microsoft.Web/sites/basicPublishingCredentialsPolicies/read",
      "Microsoft.Web/sites/basicPublishingCredentialsPolicies/write",
      "Microsoft.OperationalInsights/workspaces/read",
      "Microsoft.OperationalInsights/workspaces/write",
      "Microsoft.OperationalInsights/workspaces/query/read",
      "Microsoft.OperationalInsights/workspaces/delete",
      "Microsoft.Insights/components/read",
      "Microsoft.Insights/components/write",
      "Microsoft.Insights/components/delete",
      "Microsoft.Insights/actionGroups/read",
      "Microsoft.Insights/actionGroups/write",
      "Microsoft.Insights/actionGroups/delete",
      "Microsoft.Insights/metricAlerts/read",
      "Microsoft.Insights/metricAlerts/write",
      "Microsoft.Insights/metricAlerts/delete",
      "Microsoft.Insights/diagnosticSettings/read",
      "Microsoft.Insights/diagnosticSettings/write",
      "Microsoft.Insights/diagnosticSettings/delete",
      "Microsoft.Insights/scheduledQueryRules/read",
      "Microsoft.Insights/scheduledQueryRules/write",
      "Microsoft.Insights/scheduledQueryRules/delete",
      "Microsoft.Network/virtualNetworks/read",
      "Microsoft.Network/virtualNetworks/write",
      "Microsoft.Network/virtualNetworks/delete",
      "Microsoft.Network/virtualNetworks/subnets/read",
      "Microsoft.Network/virtualNetworks/subnets/write",
      "Microsoft.Network/virtualNetworks/subnets/delete",
      "Microsoft.Network/publicIPAddresses/read",
      "Microsoft.Network/publicIPAddresses/write",
      "Microsoft.Network/publicIPAddresses/delete",
      "Microsoft.Network/publicIPAddresses/join/action",
      "Microsoft.Network/natGateways/read",
      "Microsoft.Network/natGateways/write",
      "Microsoft.Network/natGateways/delete",
      "Microsoft.Network/natGateways/join/action"
    ]
  }

  assignable_scopes = [local.subscription_scope]
}

resource "azurerm_role_assignment" "deployment" {
  scope                            = azurerm_resource_group.control.id
  role_definition_id               = azurerm_role_definition.deployment.role_definition_resource_id
  principal_id                     = var.deployment_principal_object_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "deployment_subscription_reader" {
  scope                            = local.subscription_scope
  role_definition_id               = "${local.subscription_scope}/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7"
  principal_id                     = var.deployment_principal_object_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}
