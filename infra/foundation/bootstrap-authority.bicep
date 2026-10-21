targetScope = 'subscription'

@description('Lowercase SHA-256 of the separately reviewed saved initial-control plan.')
@minLength(64)
@maxLength(64)
param reviewedPlanDigest string

@description('Lowercase SHA-256 of the separately reviewed initial control-foundation template.')
@minLength(64)
@maxLength(64)
param controlTemplateDigest string

var expectedSubscriptionId = 'a0000000-0000-4000-8000-000000000001'
var expectedTenantId = 'a0000000-0000-4000-8000-000000000002'
var stateResourceGroupName = 'rg-switchyard-example-state'
var bootstrapIdentityName = 'id-switchyard-infra-bootstrap-uksouth'
var initialControlCreatorRoleDefinitionName = guid(subscription().id, 'switchyard-initial-control-creator')
var reviewedPlanDigestWithoutHex = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(reviewedPlanDigest, '0', ''), '1', ''), '2', ''), '3', ''), '4', ''), '5', ''), '6', ''), '7', ''), '8', ''), '9', ''), 'a', ''), 'b', ''), 'c', ''), 'd', ''), 'e', ''), 'f', '')
var controlTemplateDigestWithoutHex = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(controlTemplateDigest, '0', ''), '1', ''), '2', ''), '3', ''), '4', ''), '5', ''), '6', ''), '7', ''), '8', ''), '9', ''), 'a', ''), 'b', ''), 'c', ''), 'd', ''), 'e', ''), 'f', '')
var activationAllowed = subscription().subscriptionId == expectedSubscriptionId && tenant().tenantId == expectedTenantId && length(reviewedPlanDigest) == 64 && empty(reviewedPlanDigestWithoutHex) && length(controlTemplateDigest) == 64 && empty(controlTemplateDigestWithoutHex)

resource bootstrapIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  scope: resourceGroup(stateResourceGroupName)
  name: bootstrapIdentityName
}

resource initialControlCreatorRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  name: initialControlCreatorRoleDefinitionName
}

var assignmentName = guid(subscription().id, bootstrapIdentity.id, initialControlCreatorRole.id, reviewedPlanDigest, controlTemplateDigest)
var assignmentDescription = 'Temporary Switchyard initial control authority for plan ${reviewedPlanDigest} and control template ${controlTemplateDigest}.'

resource initialControlCreatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (activationAllowed) {
  name: assignmentName
  properties: {
    description: assignmentDescription
    principalId: bootstrapIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: initialControlCreatorRole.id
  }
}

output activated bool = activationAllowed
output assignmentId string = activationAllowed ? initialControlCreatorAssignment.id : ''
output assignmentName string = activationAllowed ? assignmentName : ''
output bootstrapPrincipalId string = activationAllowed ? bootstrapIdentity.properties.principalId : ''
output roleDefinitionId string = activationAllowed ? initialControlCreatorRole.id : ''
output reviewedPlanDigest string = activationAllowed ? reviewedPlanDigest : ''
output controlTemplateDigest string = activationAllowed ? controlTemplateDigest : ''
