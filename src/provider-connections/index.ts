export {
  PROVIDER_CONNECTIONS_ENVIRONMENT_VARIABLE,
  PROVIDER_CONNECTIONS_FILE_ENVIRONMENT_VARIABLE,
  ProviderConnectionConfigurationError,
  parseConfiguredConnections,
  readConfiguredConnections,
  type ConfiguredConnection,
  type ConfiguredGitHubConnection,
  type ConfiguredSlackConnection,
  type ConfiguredTelegramConnection,
} from "./environment.js";
export {
  activateProviderConnectionsAtStartup,
  type ActivateProviderConnectionsOptions,
  type ProviderConnectionActivationFailure,
} from "./activation.js";
