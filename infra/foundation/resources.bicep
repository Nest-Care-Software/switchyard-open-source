targetScope = 'resourceGroup'

@description('Full reviewed commit SHA containing both final reusable infrastructure engines.')
@minLength(40)
@maxLength(40)
param finalEngineSha string

@description('Exact custom audience registered only for the planner identity.')
@allowed([
  'api://switchyard-900000003/infrastructure/planner'
])
param plannerAudience string

@description('Exact custom audience registered only for the steady foundation applier identity.')
@allowed([
  'api://switchyard-900000003/infrastructure/foundation-applier'
])
param foundationAudience string

@description('Exact custom audience registered only for the bootstrap applier identity.')
@allowed([
  'api://switchyard-900000003/infrastructure/bootstrap-applier'
])
param bootstrapAudience string

param stateReaderRoleDefinitionId string
param approvalBlobCustodianRoleDefinitionId string
param deployReceiptImmutabilityPolicy bool

var repository = 'example-org/switchyard'
var subjectPrefix = 'repo:example-org@900000004/switchyard@900000003:ref:refs/heads/main:job_workflow_ref:${repository}'
var planSubject = '${subjectPrefix}/.github/workflows/infrastructure-plan-engine.yml@${finalEngineSha}'
var applySubject = '${subjectPrefix}/.github/workflows/infrastructure-apply-engine.yml@${finalEngineSha}'
var location = resourceGroup().location
var tags = {
  'managed-by': 'bicep'
  system: 'switchyard'
  purpose: 'infrastructure-approval-foundation'
}

resource stateResourceGroupLock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: 'switchyard-state-cannot-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'Protects the external Switchyard state and approval-control foundation from deletion.'
  }
}

resource stateStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'swexampleapprovalstate'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
        file: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Allow'
    }
  }
}

resource stateBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  name: 'default'
  parent: stateStorage
  properties: {
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    deleteRetentionPolicy: {
      enabled: true
      days: 30
      allowPermanentDelete: false
    }
    isVersioningEnabled: true
  }
}

resource tfstateContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: 'tfstate'
  parent: stateBlobService
  properties: {
    publicAccess: 'None'
  }
}

resource applyControlContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: 'apply-control'
  parent: stateBlobService
  properties: {
    publicAccess: 'None'
  }
}

resource receiptStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'swexampleapprovalreceipt'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
        file: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Allow'
    }
  }
}

resource receiptBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  name: 'default'
  parent: receiptStorage
  properties: {
    containerDeleteRetentionPolicy: {
      enabled: false
    }
    deleteRetentionPolicy: {
      enabled: false
    }
    isVersioningEnabled: false
  }
}

resource planReceiptsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: 'plan-receipts'
  parent: receiptBlobService
  properties: {
    publicAccess: 'None'
  }
}

resource planReceiptsImmutability 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = if (deployReceiptImmutabilityPolicy) {
  name: 'default'
  parent: planReceiptsContainer
  properties: {
    allowProtectedAppendWrites: false
    allowProtectedAppendWritesAll: false
    immutabilityPeriodSinceCreationInDays: 1
  }
}

resource plannerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-switchyard-infra-planner-uksouth'
  location: location
  tags: tags
}

resource foundationIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-switchyard-infra-foundation-uksouth'
  location: location
  tags: tags
}

resource bootstrapIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-switchyard-infra-bootstrap-uksouth'
  location: location
  tags: tags
}

resource plannerFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  name: 'github-infrastructure-plan-engine'
  parent: plannerIdentity
  properties: {
    audiences: [plannerAudience]
    issuer: 'https://token.actions.githubusercontent.com'
    subject: planSubject
  }
}

resource foundationFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  name: 'github-infrastructure-apply-engine'
  parent: foundationIdentity
  properties: {
    audiences: [foundationAudience]
    issuer: 'https://token.actions.githubusercontent.com'
    subject: applySubject
  }
}

resource bootstrapFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  name: 'github-infrastructure-apply-engine'
  parent: bootstrapIdentity
  properties: {
    audiences: [bootstrapAudience]
    issuer: 'https://token.actions.githubusercontent.com'
    subject: applySubject
  }
}

resource plannerStateReaderAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(tfstateContainer.id, plannerIdentity.id, stateReaderRoleDefinitionId)
  scope: tfstateContainer
  properties: {
    principalId: plannerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: stateReaderRoleDefinitionId
  }
}

resource foundationStateAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(tfstateContainer.id, foundationIdentity.id, approvalBlobCustodianRoleDefinitionId)
  scope: tfstateContainer
  properties: {
    principalId: foundationIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: approvalBlobCustodianRoleDefinitionId
  }
}

resource foundationControlAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applyControlContainer.id, foundationIdentity.id, approvalBlobCustodianRoleDefinitionId)
  scope: applyControlContainer
  properties: {
    principalId: foundationIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: approvalBlobCustodianRoleDefinitionId
  }
}

resource foundationReceiptAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(planReceiptsContainer.id, foundationIdentity.id, approvalBlobCustodianRoleDefinitionId)
  scope: planReceiptsContainer
  properties: {
    principalId: foundationIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: approvalBlobCustodianRoleDefinitionId
  }
}

resource bootstrapStateAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(tfstateContainer.id, bootstrapIdentity.id, approvalBlobCustodianRoleDefinitionId)
  scope: tfstateContainer
  properties: {
    principalId: bootstrapIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: approvalBlobCustodianRoleDefinitionId
  }
}

resource bootstrapControlAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applyControlContainer.id, bootstrapIdentity.id, approvalBlobCustodianRoleDefinitionId)
  scope: applyControlContainer
  properties: {
    principalId: bootstrapIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: approvalBlobCustodianRoleDefinitionId
  }
}

resource bootstrapReceiptAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(planReceiptsContainer.id, bootstrapIdentity.id, approvalBlobCustodianRoleDefinitionId)
  scope: planReceiptsContainer
  properties: {
    principalId: bootstrapIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: approvalBlobCustodianRoleDefinitionId
  }
}

output stateResourceGroupId string = resourceGroup().id
output stateStorageAccountId string = stateStorage.id
output receiptStorageAccountId string = receiptStorage.id
output plannerIdentityClientId string = plannerIdentity.properties.clientId
output plannerIdentityPrincipalId string = plannerIdentity.properties.principalId
output foundationIdentityClientId string = foundationIdentity.properties.clientId
output foundationIdentityPrincipalId string = foundationIdentity.properties.principalId
output bootstrapIdentityClientId string = bootstrapIdentity.properties.clientId
output bootstrapIdentityPrincipalId string = bootstrapIdentity.properties.principalId
