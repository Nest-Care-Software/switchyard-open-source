resource "azurerm_service_plan" "control" {
  name                = var.service_plan_name
  resource_group_name = azurerm_resource_group.control.name
  location            = azurerm_resource_group.control.location
  os_type             = "Linux"
  sku_name            = "B1"
  worker_count        = 1
  tags                = local.tags
}

resource "azurerm_linux_function_app" "control" {
  name                = var.function_app_name
  resource_group_name = azurerm_resource_group.control.name
  location            = azurerm_resource_group.control.location
  service_plan_id     = azurerm_service_plan.control.id
  zip_deploy_file     = var.function_package_deployment_enabled ? var.function_package_path : null

  storage_account_name          = azurerm_storage_account.control.name
  storage_uses_managed_identity = true

  builtin_logging_enabled                        = false
  client_certificate_enabled                     = false
  content_share_force_disabled                   = true
  ftp_publish_basic_authentication_enabled       = false
  functions_extension_version                    = "~4"
  https_only                                     = true
  key_vault_reference_identity_id                = azurerm_user_assigned_identity.controller.id
  public_network_access_enabled                  = true
  webdeploy_publish_basic_authentication_enabled = false

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.controller.id]
  }

  auth_settings_v2 {
    auth_enabled           = true
    default_provider       = "azureactivedirectory"
    require_authentication = true
    require_https          = true
    runtime_version        = "~1"
    unauthenticated_action = "Return401"

    active_directory_v2 {
      client_id            = var.function_auth_client_id
      tenant_auth_endpoint = "https://login.microsoftonline.com/${var.tenant_id}/v2.0"
      allowed_audiences    = [local.function_audience]
      allowed_applications = [var.github_workload_client_id]
    }

    login {
      token_store_enabled = false
    }
  }

  site_config {
    always_on                = true
    ftps_state               = "Disabled"
    http2_enabled            = true
    minimum_tls_version      = "1.2"
    remote_debugging_enabled = false
    scm_minimum_tls_version  = "1.2"

    application_stack {
      node_version = "24"
    }
  }

  app_settings = merge(
    {
      "APPLICATIONINSIGHTS_AUTHENTICATION_STRING" = "ClientId=${azurerm_user_assigned_identity.controller.client_id};Authorization=AAD"
      "APPLICATIONINSIGHTS_CONNECTION_STRING"     = azurerm_application_insights.control.connection_string
      "AzureWebJobsStorage__accountName"          = azurerm_storage_account.control.name
      "AzureWebJobsStorage__clientId"             = azurerm_user_assigned_identity.controller.client_id
      "AzureWebJobsStorage__credential"           = "managedidentity"
      "FUNCTIONS_WORKER_RUNTIME"                  = "node"
      "FUNCTIONS_WORKER_PROCESS_COUNT"            = "1"
      "SCM_DO_BUILD_DURING_DEPLOYMENT"            = "false"

      "SWITCHYARD_AZURE_IMAGE_VERSION"        = var.runner_image_version
      "SWITCHYARD_AZURE_SUBSCRIPTION_ID"      = var.subscription_id
      "SWITCHYARD_BOOTSTRAP_SHA256"           = filesha256("${path.module}/../../assets/azure-runner/bootstrap.sh")
      "SWITCHYARD_LEDGER_ACCOUNT_NAME"        = azurerm_storage_account.control.name
      "SWITCHYARD_LEDGER_INSTANCE_ID"         = var.ledger_instance_id
      "SWITCHYARD_LEDGER_PARTITION_KEY"       = var.ledger_partition_key
      "SWITCHYARD_LEDGER_SCHEMA_VERSION"      = tostring(var.ledger_schema_version)
      "SWITCHYARD_LEDGER_TABLE_NAME"          = azapi_resource.authoritative_table.name
      "SWITCHYARD_MANAGED_IDENTITY_CLIENT_ID" = azurerm_user_assigned_identity.controller.client_id
      "SWITCHYARD_PROVISIONING_POISON_QUEUE"  = var.queue_names.provisioning_poison
      "SWITCHYARD_PROVISIONING_QUEUE"         = var.queue_names.provisioning
      "SWITCHYARD_RUNNER_SUBNET_ID"           = azurerm_subnet.runners.id
      "SWITCHYARD_RUNTIME_INSTANCE_ID"        = var.function_app_name
      "SWITCHYARD_TEMPLATE_SHA256"            = filesha256("${path.module}/../../templates/azure-allocation/main.json")
    },
    var.function_package_deployment_enabled ? {
      "SWITCHYARD_FUNCTION_ARTIFACT_SHA256" = var.function_package_sha256
      "WEBSITE_RUN_FROM_PACKAGE"            = "1"
    } : {},
    var.admission_runtime_settings
  )

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.controller_storage_data,
    azurerm_role_assignment.controller_monitoring_metrics,
    azurerm_role_assignment.ledger_runtime_data,
  ]

  lifecycle {
    precondition {
      condition = var.function_package_deployment_enabled ? (
        var.function_package_path != null &&
        var.function_package_sha256 != null &&
        filesha256(var.function_package_path) == var.function_package_sha256
        ) : (
        var.function_package_path == null && var.function_package_sha256 == null
      )
      error_message = "Function ZIP deployment requires the exact reviewed path and matching SHA-256; both inputs must remain null while deployment is disabled."
    }
  }
}
