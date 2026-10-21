targetScope = 'subscription'

@description('Full reviewed commit SHA containing both final reusable infrastructure engines.')
@minLength(40)
@maxLength(40)
param finalEngineSha string

@description('Deploys the receipt immutability policy only while it is absent or still Unlocked. The owner wrapper derives this from live evidence.')
param deployReceiptImmutabilityPolicy bool = true

var expectedSubscriptionId = 'a0000000-0000-4000-8000-000000000001'
var expectedTenantId = 'a0000000-0000-4000-8000-000000000002'
var disabledEngineSha = '49be281fc0d6c2cf746a0ce0f6db517d0ac821af'
var plannerAudience = 'api://switchyard-900000003/infrastructure/planner'
var foundationAudience = 'api://switchyard-900000003/infrastructure/foundation-applier'
var bootstrapAudience = 'api://switchyard-900000003/infrastructure/bootstrap-applier'
var readerRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
var location = 'uksouth'
var tags = {
  'managed-by': 'bicep'
  system: 'switchyard'
  purpose: 'infrastructure-approval-foundation'
}
var finalEngineShaWithoutHex = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(finalEngineSha, '0', ''), '1', ''), '2', ''), '3', ''), '4', ''), '5', ''), '6', ''), '7', ''), '8', ''), '9', ''), 'a', ''), 'b', ''), 'c', ''), 'd', ''), 'e', ''), 'f', '')
var activationAllowed = subscription().subscriptionId == expectedSubscriptionId && tenant().tenantId == expectedTenantId && finalEngineSha != disabledEngineSha && length(finalEngineSha) == 40 && empty(finalEngineShaWithoutHex)

resource stateResourceGroup 'Microsoft.Resources/resourceGroups@2024-11-01' = if (activationAllowed) {
  name: 'rg-switchyard-example-state'
  location: location
  tags: tags
}

resource stateReaderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = if (activationAllowed) {
  name: guid(subscription().id, 'switchyard-infrastructure-state-reader')
  properties: {
    assignableScopes: [subscription().id]
    description: 'Reads only the exact OpenTofu state blob scope assigned to the planner.'
    permissions: [
      {
        actions: []
        dataActions: [
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
        ]
        notActions: []
        notDataActions: []
      }
    ]
    roleName: 'Switchyard infrastructure state reader'
    type: 'CustomRole'
  }
}

resource plannerLogQueryRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = if (activationAllowed) {
  name: guid(subscription().id, 'switchyard-infrastructure-log-query-planner')
  properties: {
    assignableScopes: [subscription().id]
    description: 'Reads only Log Analytics query results required to refresh the reviewed scheduled-query alert during planning.'
    permissions: [
      {
        actions: [
          'Microsoft.OperationalInsights/workspaces/query/read'
        ]
        dataActions: []
        notActions: []
        notDataActions: []
      }
    ]
    roleName: 'Switchyard infrastructure log query planner'
    type: 'CustomRole'
  }
}

resource approvalBlobCustodianRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = if (activationAllowed) {
  name: guid(subscription().id, 'switchyard-infrastructure-approval-blob-custodian')
  properties: {
    assignableScopes: [subscription().id]
    description: 'Reads and conditionally writes state, receipt, lease and intent blobs at separately assigned container scopes.'
    permissions: [
      {
        actions: []
        dataActions: [
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'
        ]
        notActions: []
        notDataActions: []
      }
    ]
    roleName: 'Switchyard infrastructure approval blob custodian'
    type: 'CustomRole'
  }
}

resource initialControlCreatorRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = if (activationAllowed) {
  name: guid(subscription().id, 'switchyard-initial-control-creator')
  properties: {
    assignableScopes: [subscription().id]
    description: 'Creates only the reviewed initial Switchyard control foundation. It has no delete or data-plane permission and is deliberately unassigned by this deployment.'
    permissions: [
      {
        actions: [
          'Microsoft.Resources/subscriptions/read'
          'Microsoft.Resources/subscriptions/locations/read'
          'Microsoft.Resources/providers/read'
          'Microsoft.Resources/subscriptions/providers/read'
          'Microsoft.Resources/subscriptions/resourceGroups/read'
          'Microsoft.Resources/subscriptions/resourceGroups/write'
          'Microsoft.Authorization/roleDefinitions/read'
          'Microsoft.Authorization/roleDefinitions/write'
          'Microsoft.Authorization/roleAssignments/read'
          'Microsoft.Authorization/roleAssignments/write'
          'Microsoft.Authorization/locks/read'
          'Microsoft.Authorization/locks/write'
          'Microsoft.ManagedIdentity/userAssignedIdentities/read'
          'Microsoft.ManagedIdentity/userAssignedIdentities/write'
          'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action'
          'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/read'
          'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/write'
          'Microsoft.Storage/storageAccounts/read'
          'Microsoft.Storage/storageAccounts/write'
          'Microsoft.Storage/storageAccounts/managementPolicies/read'
          'Microsoft.Storage/storageAccounts/managementPolicies/write'
          'Microsoft.Storage/storageAccounts/blobServices/read'
          'Microsoft.Storage/storageAccounts/blobServices/write'
          'Microsoft.Storage/storageAccounts/blobServices/containers/read'
          'Microsoft.Storage/storageAccounts/blobServices/containers/write'
          'Microsoft.Storage/storageAccounts/queueServices/read'
          'Microsoft.Storage/storageAccounts/queueServices/queues/read'
          'Microsoft.Storage/storageAccounts/queueServices/queues/write'
          'Microsoft.Storage/storageAccounts/tableServices/read'
          'Microsoft.Storage/storageAccounts/tableServices/tables/read'
          'Microsoft.Storage/storageAccounts/tableServices/tables/write'
          'Microsoft.KeyVault/vaults/read'
          'Microsoft.KeyVault/vaults/write'
          'Microsoft.Web/serverfarms/read'
          'Microsoft.Web/serverfarms/write'
          'Microsoft.Web/checknameavailability/read'
          'Microsoft.Web/sites/read'
          'Microsoft.Web/sites/write'
          'Microsoft.Web/sites/config/read'
          'Microsoft.Web/sites/config/write'
          'Microsoft.Web/sites/config/list/action'
          'Microsoft.Web/sites/basicPublishingCredentialsPolicies/read'
          'Microsoft.Web/sites/basicPublishingCredentialsPolicies/write'
          'Microsoft.OperationalInsights/workspaces/read'
          'Microsoft.OperationalInsights/workspaces/write'
          'Microsoft.OperationalInsights/workspaces/query/read'
          'Microsoft.OperationalInsights/deletedworkspaces/read'
          'Microsoft.Insights/components/read'
          'Microsoft.Insights/components/write'
          'Microsoft.Insights/components/currentbillingfeatures/read'
          'Microsoft.Insights/components/currentbillingfeatures/write'
          'Microsoft.Insights/actionGroups/read'
          'Microsoft.Insights/actionGroups/write'
          'Microsoft.Insights/metricAlerts/read'
          'Microsoft.Insights/metricAlerts/write'
          'Microsoft.Insights/diagnosticSettings/read'
          'Microsoft.Insights/diagnosticSettings/write'
          'Microsoft.Insights/scheduledQueryRules/read'
          'Microsoft.Insights/scheduledQueryRules/write'
          'Microsoft.Network/virtualNetworks/read'
          'Microsoft.Network/virtualNetworks/write'
          'Microsoft.Network/virtualNetworks/subnets/read'
          'Microsoft.Network/virtualNetworks/subnets/write'
          'Microsoft.Network/publicIPAddresses/read'
          'Microsoft.Network/publicIPAddresses/write'
          'Microsoft.Network/publicIPAddresses/join/action'
          'Microsoft.Network/natGateways/read'
          'Microsoft.Network/natGateways/write'
          'Microsoft.Network/natGateways/join/action'
        ]
        dataActions: []
        notActions: []
        notDataActions: []
      }
    ]
    roleName: 'Switchyard initial control creator'
    type: 'CustomRole'
  }
}

module stateResources 'resources.bicep' = if (activationAllowed) {
  name: 'switchyard-approval-foundation-resources'
  scope: stateResourceGroup
  params: {
    finalEngineSha: finalEngineSha
    plannerAudience: plannerAudience
    foundationAudience: foundationAudience
    bootstrapAudience: bootstrapAudience
    stateReaderRoleDefinitionId: stateReaderRole.id
    approvalBlobCustodianRoleDefinitionId: approvalBlobCustodianRole.id
    deployReceiptImmutabilityPolicy: deployReceiptImmutabilityPolicy
  }
}

resource plannerSubscriptionReaderAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (activationAllowed) {
  name: guid(subscription().id, stateResourceGroup.name, 'id-switchyard-infra-planner-uksouth', readerRoleDefinitionId)
  properties: {
    description: 'Subscription management-plane visibility for the read-only Switchyard infrastructure planner.'
    principalId: stateResources!.outputs.plannerIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: readerRoleDefinitionId
  }
}

resource plannerSubscriptionLogQueryAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (activationAllowed) {
  name: guid(subscription().id, stateResourceGroup.name, 'id-switchyard-infra-planner-uksouth', plannerLogQueryRole.id)
  properties: {
    description: 'Exact Log Analytics query permission needed to refresh the reviewed scheduled-query alert during read-only planning.'
    principalId: stateResources!.outputs.plannerIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: plannerLogQueryRole.id
  }
}

output activated bool = activationAllowed
output stateResourceGroupId string = activationAllowed ? stateResources!.outputs.stateResourceGroupId : ''
output stateStorageAccountId string = activationAllowed ? stateResources!.outputs.stateStorageAccountId : ''
output receiptStorageAccountId string = activationAllowed ? stateResources!.outputs.receiptStorageAccountId : ''
output plannerIdentityClientId string = activationAllowed ? stateResources!.outputs.plannerIdentityClientId : ''
output plannerIdentityPrincipalId string = activationAllowed ? stateResources!.outputs.plannerIdentityPrincipalId : ''
output foundationIdentityClientId string = activationAllowed ? stateResources!.outputs.foundationIdentityClientId : ''
output foundationIdentityPrincipalId string = activationAllowed ? stateResources!.outputs.foundationIdentityPrincipalId : ''
output bootstrapIdentityClientId string = activationAllowed ? stateResources!.outputs.bootstrapIdentityClientId : ''
output bootstrapIdentityPrincipalId string = activationAllowed ? stateResources!.outputs.bootstrapIdentityPrincipalId : ''
output initialControlCreatorRoleDefinitionId string = activationAllowed ? initialControlCreatorRole.id : ''
