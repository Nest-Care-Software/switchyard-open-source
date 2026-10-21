targetScope = 'resourceGroup'

var expectedSubscriptionId = 'a0000000-0000-4000-8000-000000000001'
var expectedTenantId = 'a0000000-0000-4000-8000-000000000002'
var expectedResourceGroupName = 'rg-switchyard-example-state'
var finalEngineSha = '5c9b286fcb5761a3fcf4b4c87882ec56103333e7'
var repository = 'example-org/switchyard'
var subjectPrefix = 'repo:example-org@900000004/switchyard@900000003:ref:refs/heads/main:job_workflow_ref:${repository}'
var planSubject = '${subjectPrefix}/.github/workflows/infrastructure-plan-engine.yml@${finalEngineSha}'
var applySubject = '${subjectPrefix}/.github/workflows/infrastructure-apply-engine.yml@${finalEngineSha}'
var activationAllowed = subscription().subscriptionId == expectedSubscriptionId && tenant().tenantId == expectedTenantId && resourceGroup().name == expectedResourceGroupName

resource plannerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-switchyard-infra-planner-uksouth'
}

resource foundationIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-switchyard-infra-foundation-uksouth'
}

resource bootstrapIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-switchyard-infra-bootstrap-uksouth'
}

resource plannerFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (activationAllowed) {
  name: 'github-infrastructure-plan-engine'
  parent: plannerIdentity
  properties: {
    audiences: ['api://switchyard-900000003/infrastructure/planner']
    issuer: 'https://token.actions.githubusercontent.com'
    subject: planSubject
  }
}

resource foundationFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (activationAllowed) {
  name: 'github-infrastructure-apply-engine'
  parent: foundationIdentity
  properties: {
    audiences: ['api://switchyard-900000003/infrastructure/foundation-applier']
    issuer: 'https://token.actions.githubusercontent.com'
    subject: applySubject
  }
}

resource bootstrapFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (activationAllowed) {
  name: 'github-infrastructure-apply-engine'
  parent: bootstrapIdentity
  properties: {
    audiences: ['api://switchyard-900000003/infrastructure/bootstrap-applier']
    issuer: 'https://token.actions.githubusercontent.com'
    subject: applySubject
  }
}

output corrected bool = activationAllowed
output planSubject string = activationAllowed ? planSubject : ''
output applySubject string = activationAllowed ? applySubject : ''
