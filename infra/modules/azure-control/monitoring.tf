resource "azurerm_log_analytics_workspace" "control" {
  name                = var.log_analytics_workspace_name
  location            = azurerm_resource_group.control.location
  resource_group_name = azurerm_resource_group.control.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_application_insights" "control" {
  name                         = var.application_insights_name
  location                     = azurerm_resource_group.control.location
  resource_group_name          = azurerm_resource_group.control.name
  workspace_id                 = azurerm_log_analytics_workspace.control.id
  application_type             = "Node.JS"
  local_authentication_enabled = false
  retention_in_days            = 30
  tags                         = local.tags
}

resource "azurerm_role_assignment" "controller_monitoring_metrics" {
  scope                            = azurerm_application_insights.control.id
  role_definition_id               = "${local.subscription_scope}/providers/Microsoft.Authorization/roleDefinitions/3913510d-42f4-4e42-8a64-420c390055eb"
  principal_id                     = azurerm_user_assigned_identity.controller.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_monitor_action_group" "owner" {
  name                = var.action_group_name
  resource_group_name = azurerm_resource_group.control.name
  short_name          = var.action_group_short_name
  enabled             = true
  tags                = local.tags

  email_receiver {
    name                    = "switchyard-owner"
    email_address           = var.alert_email
    use_common_alert_schema = true
  }
}

resource "azurerm_monitor_diagnostic_setting" "function" {
  name                       = "send-function-logs-to-workspace"
  target_resource_id         = azurerm_linux_function_app.control.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.control.id

  enabled_log {
    category = "FunctionAppLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_metric_alert" "function_http_5xx" {
  name                = "switchyard-function-http-5xx"
  resource_group_name = azurerm_resource_group.control.name
  scopes              = [azurerm_linux_function_app.control.id]
  description         = "The authenticated public Switchyard allocation API returned one or more HTTP 5xx responses."
  severity            = 1
  frequency           = "PT1M"
  window_size         = "PT5M"
  enabled             = true
  auto_mitigate       = true
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.Web/sites"
    metric_name      = "Http5xx"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 0
  }

  action {
    action_group_id = azurerm_monitor_action_group.owner.id
  }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "safety_incident" {
  name                  = "switchyard-safety-incident"
  resource_group_name   = azurerm_resource_group.control.name
  location              = azurerm_resource_group.control.location
  scopes                = [azurerm_application_insights.control.id]
  description           = "Switchyard emitted an allowlisted safety incident or failed reconciliation heartbeat."
  display_name          = "Switchyard safety incident"
  severity              = 0
  enabled               = true
  evaluation_frequency  = "PT1M"
  window_duration       = "PT5M"
  skip_query_validation = true
  tags                  = local.tags

  criteria {
    query                   = <<-KQL
      AppTraces
      | where (Message has_cs '\"event\":\"switchyard-safety-incident\"')
          or (Message has_cs '\"event\":\"switchyard-lifecycle\"' and Message has_cs '\"result_code\":\"incomplete\"')
    KQL
    operator                = "GreaterThan"
    threshold               = 0
    time_aggregation_method = "Count"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.owner.id]
  }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "provisioning_poison" {
  name                  = "switchyard-provisioning-poison"
  resource_group_name   = azurerm_resource_group.control.name
  location              = azurerm_resource_group.control.location
  scopes                = [azurerm_application_insights.control.id]
  description           = "A raw Azure provisioning message reached the poison queue and requires owner review."
  display_name          = "Switchyard provisioning poison message"
  severity              = 0
  enabled               = true
  evaluation_frequency  = "PT1M"
  window_duration       = "PT5M"
  skip_query_validation = true
  tags                  = local.tags

  criteria {
    query                   = <<-KQL
      AppTraces
      | where Message has_cs '\"event\":\"switchyard-lifecycle\"'
      | where Message has_cs '\"stage_code\":\"azure-provision-poison\"'
    KQL
    operator                = "GreaterThan"
    threshold               = 0
    time_aggregation_method = "Count"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.owner.id]
  }
}
