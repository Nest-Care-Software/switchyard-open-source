output "control" {
  description = "Non-secret shared Azure foundation outputs."
  value = {
    allocation_template_defaults        = module.control.allocation_template_defaults
    authoritative_ledger                = module.control.authoritative_ledger
    resource_group_id                   = module.control.control_resource_group_id
    resource_group_lock_id              = module.control.control_resource_group_lock_id
    controller_identity                 = module.control.controller_identity
    deployment_role_definition_id       = module.control.deployment_role_definition_id
    function_api                        = module.control.function_api
    key_vault_uri                       = module.control.key_vault_uri
    ledger_bootstrap_identity           = module.control.ledger_bootstrap_identity
    ledger_bootstrap_role_definition_id = module.control.ledger_bootstrap_role_definition_id
    ledger_runtime_role_definition_id   = module.control.ledger_runtime_role_definition_id
    monitor_action_group_id             = module.control.monitor_action_group_id
    runner_network                      = module.control.runner_network
    runtime_role_definition_id          = module.control.runtime_role_definition_id
    storage_account_id                  = module.control.storage_account_id
  }
}
