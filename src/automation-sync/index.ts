export {
  AUTOMATION_GIT_SYNC_ENVIRONMENT_VARIABLE,
  AUTOMATION_GIT_SYNC_FILE_ENVIRONMENT_VARIABLE,
  AutomationGitSyncConfigurationError,
  DECLARED_SYNC_INTERVALS,
  parseConfiguredAutomationGitSyncs,
  readConfiguredAutomationGitSyncs,
  type ConfiguredAutomationGitSync,
} from "./environment.js";
export {
  activateAutomationGitSyncsAtStartup,
  type ActivateAutomationGitSyncsOptions,
  type AutomationGitSyncActivationFailure,
} from "./activation.js";
