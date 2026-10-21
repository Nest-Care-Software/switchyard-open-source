targetScope = 'resourceGroup'

param allocationId string
param physicalGeneration int
param originalCompleteBy string
param deletionTarget string
param latestSafeStart string
@allowed([
  true
])
param deadlineContractValid bool
param mappedJobTimeoutMinutes int
param providerStopMarginMinutes int
param location string
param availabilityZone string
param vmSize string
param imageVersion string
param sharedRunnerSubnetId string
param adminSshPublicKey string
@secure()
param nonSecretBootstrapCustomData string
param allocationTags object

// The controller validates the canonical sy1-hex allocation identity and uses
// this exact deterministic name when binding deployment output to generation 1.
var allocationSuffix = substring(allocationId, 4, 20)
var physicalGenerationId = '${allocationId}:g${physicalGeneration}'
var vmName = 'swy-${allocationSuffix}-g${physicalGeneration}'
var networkSecurityGroupName = 'nsg-${vmName}'
// ARM parameters have no stable negative-match constraint. Deliberately map
// "latest" to a nonexistent version so a moving image can never deploy.
var exactImageVersion = toLower(imageVersion) == 'latest' ? 'INVALID-LATEST-IS-FORBIDDEN' : imageVersion
var generationTags = union(allocationTags, {
  deadlineContractValidated: string(deadlineContractValid)
  deletionTarget: deletionTarget
  latestSafeStart: latestSafeStart
  originalCompleteBy: originalCompleteBy
  physicalGeneration: string(physicalGeneration)
  physicalGenerationId: physicalGenerationId
})

resource networkSecurityGroup 'Microsoft.Network/networkSecurityGroups@2025-01-01' = {
  name: networkSecurityGroupName
  location: location
  properties: {
    securityRules: [
      {
        name: 'DenyAllInbound'
        properties: {
          access: 'Deny'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
          direction: 'Inbound'
          priority: 4096
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
        }
      }
      {
        name: 'AllowAzurePlatformDnsUdp'
        properties: {
          access: 'Allow'
          destinationAddressPrefix: 'AzurePlatformDNS'
          destinationPortRange: '53'
          direction: 'Outbound'
          priority: 100
          protocol: 'Udp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
        }
      }
      {
        name: 'AllowAzurePlatformDnsTcp'
        properties: {
          access: 'Allow'
          destinationAddressPrefix: 'AzurePlatformDNS'
          destinationPortRange: '53'
          direction: 'Outbound'
          priority: 110
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
        }
      }
      {
        name: 'AllowAzurePlatformImds'
        properties: {
          access: 'Allow'
          destinationAddressPrefix: 'AzurePlatformIMDS'
          destinationPortRange: '80'
          direction: 'Outbound'
          priority: 120
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
        }
      }
      {
        name: 'AllowAzureWireServer'
        properties: {
          access: 'Allow'
          destinationAddressPrefix: '168.63.129.16'
          destinationPortRanges: [
            '80'
            '32526'
          ]
          direction: 'Outbound'
          priority: 130
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
        }
      }
      {
        name: 'AllowHttps'
        properties: {
          access: 'Allow'
          destinationAddressPrefix: 'Internet'
          destinationPortRange: '443'
          direction: 'Outbound'
          priority: 140
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
        }
      }
      {
        name: 'DenyAllOutbound'
        properties: {
          access: 'Deny'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
          direction: 'Outbound'
          priority: 4096
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
        }
      }
    ]
  }
  tags: generationTags
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2025-01-01' = {
  name: 'pip-${vmName}'
  location: location
  zones: [
    availabilityZone
  ]
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    deleteOption: 'Delete'
    idleTimeoutInMinutes: 4
    publicIPAddressVersion: 'IPv4'
    publicIPAllocationMethod: 'Static'
  }
  tags: generationTags
}

resource networkInterface 'Microsoft.Network/networkInterfaces@2025-01-01' = {
  name: 'nic-${vmName}'
  location: location
  properties: {
    enableAcceleratedNetworking: true
    networkSecurityGroup: {
      id: networkSecurityGroup.id
    }
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          primary: true
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: sharedRunnerSubnetId
          }
          publicIPAddress: {
            id: publicIp.id
            properties: {
              deleteOption: 'Delete'
            }
          }
        }
      }
    ]
  }
  tags: generationTags
}

resource virtualMachine 'Microsoft.Compute/virtualMachines@2025-04-01' = {
  name: vmName
  location: location
  zones: [
    availabilityZone
  ]
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: networkInterface.id
          properties: {
            deleteOption: 'Delete'
            primary: true
          }
        }
      ]
    }
    osProfile: {
      computerName: vmName
      adminUsername: 'switchyard'
      customData: base64(nonSecretBootstrapCustomData)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: {
          publicKeys: [
            {
              path: '/home/switchyard/.ssh/authorized_keys'
              keyData: adminSshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: exactImageVersion
      }
      osDisk: {
        name: 'osdisk-${vmName}'
        caching: 'ReadWrite'
        createOption: 'FromImage'
        deleteOption: 'Delete'
        diskSizeGB: 64
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
      }
    }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
  tags: generationTags
}

output physicalGeneration int = physicalGeneration
output physicalGenerationId string = physicalGenerationId
output virtualMachineId string = virtualMachine.id
output virtualMachineName string = virtualMachine.name
output networkSecurityGroupId string = networkSecurityGroup.id
output networkInterfaceId string = networkInterface.id
output publicIpAddressId string = publicIp.id
output computeScheduleTarget object = {
  deadlineType: 'CompleteBy'
  originalCompleteBy: originalCompleteBy
  physicalGeneration: physicalGeneration
  physicalGenerationId: physicalGenerationId
  requiresFreshAcceptedOperation: true
  virtualMachineId: virtualMachine.id
}
output deadlineContract object = {
  deletionTarget: deletionTarget
  latestSafeStart: latestSafeStart
  mappedJobTimeoutMinutes: mappedJobTimeoutMinutes
  originalCompleteBy: originalCompleteBy
  providerStopMarginMinutes: providerStopMarginMinutes
}
output imageReference object = {
  publisher: 'Canonical'
  offer: 'ubuntu-24_04-lts'
  sku: 'server'
  version: exactImageVersion
}
