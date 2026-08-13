import { describe, expect, test } from "bun:test";

import type {
  AgentChatProviderCatalogue,
  AgentChatProviderInstance,
} from "./control/agentChat";
import {
  modelRouteKey,
  modelsForProvider,
  selectableProviderInstances,
  shouldShowProviderSelector,
} from "./providerSelection";

const instance = (
  id: string,
  readiness: "ready" | "not_ready",
): AgentChatProviderInstance => ({
  provider_instance_id: id,
  instance_revision: "1",
  runtime_adapter_id: `runtime:${id}`,
  driver_id: `driver:${id}`,
  integration_family: "fixture",
  transport_family: "fixture",
  protocol_facade_id: `facade:${id}`,
  display_name: id,
  harness_name: id,
  ownership: "external_attached",
  selection_readiness: readiness,
  credential_posture: {
    profile_id: `profile:${id}`,
    mechanism: "api_key",
    credential_state: readiness === "ready" ? "ready" : "required",
    entitlement_metering: "pay_as_you_go",
    entitlement_state: readiness === "ready" ? "available" : "unknown",
    endpoint_authorization: readiness === "ready" ? "allowed" : "unknown",
    runtime_readiness: readiness,
    support_authority: "provider_supported",
    evidence_provenance: "observed",
  },
  credential: null,
  model_catalogue_state: readiness === "ready" ? "available" : "unavailable",
  model_catalogue_diagnostic: null,
  tool_capable: id === "one",
  tool_capable_reason: id === "one" ? null : `route ${id} does not realize consumer tools`,
  models: readiness === "ready"
    ? [{
        provider_id: id === "two" ? "provider:two" : null,
        model: "shared-model",
        display_name: "Shared model",
        description: "",
        default_reasoning_effort: "low",
        supported_reasoning_efforts: [{ reasoning_effort: "low", description: "" }],
      }]
    : [],
});

describe("provider selection", () => {
  test("shows a selector only for multiple ready configured instances", () => {
    const catalogue: AgentChatProviderCatalogue = {
      instances: [instance("one", "ready"), instance("blocked", "not_ready")],
    };
    expect(selectableProviderInstances(catalogue).map(({ provider_instance_id }) => provider_instance_id))
      .toEqual(["one"]);
    expect(shouldShowProviderSelector(catalogue)).toBe(false);

    catalogue.instances.push(instance("two", "ready"));
    expect(shouldShowProviderSelector(catalogue)).toBe(true);
    expect(modelsForProvider(catalogue, "blocked")).toEqual([]);
    expect(modelRouteKey(modelsForProvider(catalogue, "two")[0]))
      .toBe("provider:two:shared-model");
  });
});
