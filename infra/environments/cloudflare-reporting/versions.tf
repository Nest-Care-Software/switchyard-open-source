terraform {
  required_version = "= 1.12.1"

  backend "azurerm" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.23.0"
    }
  }
}
