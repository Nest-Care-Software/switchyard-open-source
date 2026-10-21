terraform {
  required_version = "= 1.12.1"

  backend "azurerm" {}

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "= 2.12.0"
    }

    azurerm = {
      source  = "hashicorp/azurerm"
      version = "= 5.2.0"
    }
  }
}
