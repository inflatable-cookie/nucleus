import type {
  AgentChatModelOption,
  AgentChatProviderCatalogue,
  AgentChatProviderInstance,
} from "./control/agentChat";

export function selectableProviderInstances(
  catalogue: AgentChatProviderCatalogue,
): AgentChatProviderInstance[] {
  return catalogue.instances.filter(
    (instance) => instance.selection_readiness === "ready",
  );
}

export function shouldShowProviderSelector(
  catalogue: AgentChatProviderCatalogue,
): boolean {
  return selectableProviderInstances(catalogue).length > 1;
}

export function modelsForProvider(
  catalogue: AgentChatProviderCatalogue,
  providerInstanceId: string,
): AgentChatModelOption[] {
  return catalogue.instances.find(
    (instance) => instance.provider_instance_id === providerInstanceId,
  )?.models ?? [];
}

export function modelRouteKey(
  option: Pick<AgentChatModelOption, "model" | "provider_id">,
): string {
  return option.provider_id ? `${option.provider_id}:${option.model}` : option.model;
}
