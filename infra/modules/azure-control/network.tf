resource "azurerm_virtual_network" "runners" {
  name                = var.virtual_network_name
  location            = azurerm_resource_group.control.location
  resource_group_name = azurerm_resource_group.control.name
  address_space       = var.virtual_network_address_space
  tags                = local.tags
}

resource "azurerm_subnet" "runners" {
  name                 = var.runner_subnet_name
  resource_group_name  = azurerm_resource_group.control.name
  virtual_network_name = azurerm_virtual_network.runners.name
  address_prefixes     = var.runner_subnet_prefixes

  default_outbound_access_enabled = false
}

resource "azurerm_public_ip" "runner_egress" {
  name                = var.nat_public_ip_name
  location            = azurerm_resource_group.control.location
  resource_group_name = azurerm_resource_group.control.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_nat_gateway" "runners" {
  name                    = var.nat_gateway_name
  location                = azurerm_resource_group.control.location
  resource_group_name     = azurerm_resource_group.control.name
  sku_name                = "Standard"
  idle_timeout_in_minutes = 4
  tags                    = local.tags
}

resource "azurerm_nat_gateway_public_ip_association" "runners" {
  nat_gateway_id       = azurerm_nat_gateway.runners.id
  public_ip_address_id = azurerm_public_ip.runner_egress.id
}

resource "azurerm_subnet_nat_gateway_association" "runners" {
  subnet_id      = azurerm_subnet.runners.id
  nat_gateway_id = azurerm_nat_gateway.runners.id
}
