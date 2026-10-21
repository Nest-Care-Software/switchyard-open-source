targetScope = 'subscription'

@description('Unique allocation ID. It determines the controller-owned resource-group name and is immutable for the allocation.')
@minLength(68)
@maxLength(68)
param allocationId string

@description('Exact deterministic controller-owned resource-group name derived from the immutable allocation ID before any billable side effect.')
@minLength(20)
@maxLength(90)
param allocationResourceGroupName string

@description('Physical VM generation within an allocation. The V1 pilot permits generation 1 only.')
@allowed([
  1
])
param physicalGeneration int = 1

@description('GitHub run ID used only for safe operational correlation. It follows the shared 64-digit GitHub identity bound.')
@minLength(1)
@maxLength(64)
param githubRunId string

@description('Immutable allocation acceptance timestamp in Node canonical UTC form yyyy-MM-ddTHH:mm:ss.sssZ.')
@minLength(24)
@maxLength(24)
param allocationAcceptedAt string

@description('Immutable absolute Compute Schedule CompleteBy deadline in Node canonical UTC form yyyy-MM-ddTHH:mm:ss.sssZ. Every physical generation uses this exact instant.')
@minLength(24)
@maxLength(24)
param originalCompleteBy string

@description('Immutable absolute target for complete resource-group deletion in Node canonical UTC form yyyy-MM-ddTHH:mm:ss.sssZ. It does not guarantee that Azure asynchronous deletion finishes by this instant.')
@minLength(24)
@maxLength(24)
param deletionTarget string

@description('Fixed V1 allocation lifetime. Callers cannot select or extend it.')
@allowed([
  45
])
param allocationLifetimeMinutes int = 45

@description('Literal timeout-minutes value from the independently verified approved workload mapping. Callers cannot supply this value directly.')
@minValue(1)
@maxValue(80)
param mappedJobTimeoutMinutes int

@description('Switchyard policy margin before the original compute deadline. This is policy, not an Azure provider guarantee.')
@allowed([
  5
])
param providerStopMarginMinutes int = 5

@description('V1 Azure region. Cross-region searching is not permitted.')
@allowed([
  'uksouth'
])
param location string = 'uksouth'

@description('Availability zone selected by the controller in its fixed retry order.')
@allowed([
  '1'
  '2'
  '3'
])
param availabilityZone string

@description('Capability-mapped Azure size. Callers never provide this value directly.')
@allowed([
  'Standard_D4ds_v6'
  'Standard_D8ds_v6'
])
param vmSize string

@description('Exact Canonical Ubuntu 24.04 LTS Gen2 Marketplace image version resolved in UK South. latest is forbidden.')
@minLength(5)
@maxLength(64)
param imageVersion string

@description('Resource ID of the long-lived OpenTofu-owned runner subnet. Every other allocation network resource is created inside the allocation resource group.')
@minLength(20)
param sharedRunnerSubnetId string

@description('Non-secret SSH public key required by the Azure Linux VM model. The allocation-owned NSG denies all inbound traffic, including SSH.')
@minLength(32)
param adminSshPublicKey string

@description('Reviewed, non-secret bootstrap payload supplied by the controller. It must never contain tokens, JIT configuration, private keys or credentials. The secure decorator is defence in depth for deployment history, not permission to pass secrets through VM custom data.')
@secure()
@minLength(1)
param nonSecretBootstrapCustomData string

@description('Additional non-secret allocation tags. Mandatory lifecycle tags below take precedence.')
param tags object = {}

var latestSafeStart = dateTimeAdd(originalCompleteBy, '-PT${mappedJobTimeoutMinutes + providerStopMarginMinutes}M')
var expectedOriginalCompleteBy = dateTimeAdd(allocationAcceptedAt, 'PT${allocationLifetimeMinutes - 5}M')
var expectedDeletionTarget = dateTimeAdd(allocationAcceptedAt, 'PT${allocationLifetimeMinutes}M')
var latestSafeStartOffsetMinutes = allocationLifetimeMinutes - 5 - mappedJobTimeoutMinutes - providerStopMarginMinutes
// dateTimeAdd preserves the base timestamp's format when no explicit output
// format is supplied. Direct equality therefore retains the millisecond
// precision of the controller and ledger contract.
var deadlineContractValid = originalCompleteBy == expectedOriginalCompleteBy && deletionTarget == expectedDeletionTarget && latestSafeStartOffsetMinutes >= 0
var allocationTags = union(tags, {
  allocationAcceptedAt: allocationAcceptedAt
  allocationId: allocationId
  allocationLifetimeMinutes: string(allocationLifetimeMinutes)
  deletionTarget: deletionTarget
  githubRunId: githubRunId
  latestSafeStart: latestSafeStart
  managedBy: 'switchyard-controller'
  mappedJobTimeoutMinutes: string(mappedJobTimeoutMinutes)
  originalCompleteBy: originalCompleteBy
  providerStopMarginMinutes: string(providerStopMarginMinutes)
  system: 'switchyard'
})

resource allocationResourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: allocationResourceGroupName
  location: location
  tags: allocationTags
}

module generation 'generation.bicep' = {
  name: 'switchyard-allocation-${substring(allocationId, 4, 20)}-g${physicalGeneration}'
  scope: allocationResourceGroup
  params: {
    adminSshPublicKey: adminSshPublicKey
    allocationId: allocationId
    allocationTags: allocationTags
    availabilityZone: availabilityZone
    deletionTarget: deletionTarget
    // The child parameter accepts only true. any() keeps the runtime ARM
    // allowed-values check while permitting this calculated boolean in Bicep.
    deadlineContractValid: any(deadlineContractValid)
    imageVersion: imageVersion
    latestSafeStart: latestSafeStart
    location: location
    mappedJobTimeoutMinutes: mappedJobTimeoutMinutes
    nonSecretBootstrapCustomData: nonSecretBootstrapCustomData
    originalCompleteBy: originalCompleteBy
    physicalGeneration: physicalGeneration
    providerStopMarginMinutes: providerStopMarginMinutes
    sharedRunnerSubnetId: sharedRunnerSubnetId
    vmSize: vmSize
  }
}

output allocationAcceptedAt string = allocationAcceptedAt
output allocationResourceGroupId string = allocationResourceGroup.id
output allocationResourceGroupName string = allocationResourceGroup.name
output deletionTarget string = deletionTarget
output latestSafeStart string = latestSafeStart
output originalCompleteBy string = originalCompleteBy
output physicalGeneration int = physicalGeneration
output physicalGenerationId string = generation.outputs.physicalGenerationId
output virtualMachineId string = generation.outputs.virtualMachineId
output virtualMachineName string = generation.outputs.virtualMachineName
output networkSecurityGroupId string = generation.outputs.networkSecurityGroupId
output networkInterfaceId string = generation.outputs.networkInterfaceId
output publicIpAddressId string = generation.outputs.publicIpAddressId
output computeScheduleTarget object = generation.outputs.computeScheduleTarget
output deadlineContract object = {
  allocationAcceptedAt: allocationAcceptedAt
  allocationLifetimeMinutes: allocationLifetimeMinutes
  deletionTarget: deletionTarget
  latestSafeStart: latestSafeStart
  latestSafeStartOffsetMinutes: latestSafeStartOffsetMinutes
  mappedJobTimeoutMinutes: mappedJobTimeoutMinutes
  originalCompleteBy: originalCompleteBy
  providerStopMarginMinutes: providerStopMarginMinutes
}
output imageReference object = generation.outputs.imageReference
