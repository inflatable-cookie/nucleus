<script lang="ts">
  import { onMount } from "svelte";
  import { Button, RadioGroup, Select, Text } from "@inflatable-cookie/poodle-svelte";
  import type { SettingsPageRenderContext } from "@inflatable-cookie/longhorn-settings/svelte";
  import {
    loadAgentChatProviderCatalogue,
    requestAgentChatCredentialAction,
    type AgentChatCredentialAction,
    type AgentChatCredentialActionReceipt,
    type AgentChatModelOption,
    type AgentChatProviderCatalogue,
  } from "../../control/agentChat";
  import {
    AGENT_SCOPE_ID,
    AGENT_UNIT_ID,
    DEFAULT_HARNESS_MODE_ENTRY_ID,
    DEFAULT_MODEL_ENTRY_ID,
    DEFAULT_PROVIDER_ID_ENTRY_ID,
    DEFAULT_PROVIDER_INSTANCE_ENTRY_ID,
    DEFAULT_REASONING_ENTRY_ID,
  } from "../client";
  import {
    modelRouteKey,
    selectableProviderInstances,
    shouldShowProviderSelector,
  } from "../../providerSelection";

  let { context }: { context: SettingsPageRenderContext } = $props();
  let providerCatalogue = $state<AgentChatProviderCatalogue | null>(null);
  let loadingCatalogue = $state(true);
  let credentialBusy = $state(false);
  let credentialReceipt = $state<AgentChatCredentialActionReceipt | null>(null);
  let credentialRequestSequence = 0;

  const snapshot = $derived(context.snapshot(AGENT_SCOPE_ID));
  const draft = $derived.by(() => {
    const value = context.draft(AGENT_UNIT_ID)?.intent.value;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  });
  const model = $derived(
    stringDraft("defaultModel")
      ?? effectiveString(DEFAULT_MODEL_ENTRY_ID, "gpt-5.4-mini"),
  );
  const providerInstanceId = $derived(
    stringDraft("defaultProviderInstanceId")
      ?? effectiveString(DEFAULT_PROVIDER_INSTANCE_ENTRY_ID, "codex:local-default"),
  );
  const providerId = $derived(
    stringDraft("defaultProviderId")
      ?? effectiveNullableString(DEFAULT_PROVIDER_ID_ENTRY_ID),
  );
  const providerSummary = $derived(
    providerCatalogue?.instances.find(
      (instance) => instance.provider_instance_id === providerInstanceId,
    ) ?? null,
  );
  const readyProviders = $derived(
    providerCatalogue ? selectableProviderInstances(providerCatalogue) : [],
  );
  const providerOptions = $derived(
    readyProviders.map((instance) => ({
      value: instance.provider_instance_id,
      label: instance.display_name,
    })),
  );
  const modelCatalog = $derived<AgentChatModelOption[]>(providerSummary?.models ?? []);
  const reasoningEffort = $derived(
    stringDraft("defaultReasoningEffort")
      ?? effectiveString(DEFAULT_REASONING_ENTRY_ID, "low"),
  );
  const harnessMode = $derived(
    (stringDraft("defaultHarnessMode")
      ?? effectiveString(DEFAULT_HARNESS_MODE_ENTRY_ID, "normal")) === "plan"
      ? "plan"
      : "normal",
  );
  const selectedModel = $derived(
    modelCatalog.find(
      (candidate) => candidate.model === model && candidate.provider_id === providerId,
    ) ?? modelCatalog.find((candidate) => candidate.model === model) ?? null,
  );
  const modelOptions = $derived.by(() => {
    const options = modelCatalog.map((candidate) => ({
      value: modelRouteKey(candidate),
      label: candidate.display_name,
    }));
    const routeKey = modelRouteKey({ model, provider_id: providerId });
    if (!options.some((option) => option.value === routeKey)) {
      options.unshift({ value: routeKey, label: `${model} (unavailable)` });
    }
    return options;
  });
  const reasoningOptions = $derived.by(() => {
    const options = selectedModel
      ? [...selectedModel.supported_reasoning_efforts]
        .sort((left, right) => reasoningRank(left.reasoning_effort)
          - reasoningRank(right.reasoning_effort))
        .map((candidate) => ({
          value: candidate.reasoning_effort,
          label: label(candidate.reasoning_effort),
        }))
      : [];
    if (!options.some((option) => option.value === reasoningEffort)) {
      options.push({ value: reasoningEffort, label: label(reasoningEffort) });
    }
    return options;
  });

  onMount(() => {
    let current = true;
    void loadAgentChatProviderCatalogue()
      .then((catalogue) => {
        if (!current) return;
        providerCatalogue = catalogue;
        loadingCatalogue = false;
      })
      .catch(() => {
        if (current) loadingCatalogue = false;
      });
    return () => {
      current = false;
    };
  });

  function effectiveString(entryId: string, fallback: string): string {
    const value = snapshot?.values.find(({ entryId: id }) => id === entryId)?.effective.value;
    return typeof value === "string" && value.length > 0 ? value : fallback;
  }

  function stringDraft(key: string): string | null {
    const value = draft?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  function effectiveNullableString(entryId: string): string | null {
    const value = snapshot?.values.find(({ entryId: id }) => id === entryId)?.effective.value;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  function change(next: {
    providerInstanceId?: string;
    modelRoute?: string;
    reasoningEffort?: string;
    harnessMode?: "normal" | "plan";
  }): void {
    const nextProviderId = next.providerInstanceId ?? providerInstanceId;
    const nextProvider = providerCatalogue?.instances.find(
      (instance) => instance.provider_instance_id === nextProviderId,
    );
    const selectedRoute = nextProvider?.models.find(
      (candidate) => modelRouteKey(candidate) === next.modelRoute,
    );
    const nextModel = selectedRoute?.model
      ?? (next.providerInstanceId ? nextProvider?.models[0]?.model : null)
      ?? model;
    const catalogModel = selectedRoute
      ?? nextProvider?.models.find(
        (candidate) => candidate.model === nextModel && candidate.provider_id === providerId,
      )
      ?? nextProvider?.models.find((candidate) => candidate.model === nextModel)
      ?? modelCatalog.find((candidate) => candidate.model === nextModel);
    void context.change(AGENT_UNIT_ID, {
      codecVersion: 1,
      value: {
        defaultProviderInstanceId: nextProviderId,
        defaultProviderId: catalogModel?.provider_id ?? null,
        defaultModel: nextModel,
        defaultReasoningEffort: next.reasoningEffort
          ?? (next.modelRoute ? catalogModel?.default_reasoning_effort : null)
          ?? reasoningEffort,
        defaultHarnessMode: next.harnessMode ?? harnessMode,
      },
    });
  }

  function label(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function reasoningRank(value: string): number {
    const rank = ["ultra", "max", "xhigh", "high", "medium", "low", "minimal", "none"]
      .indexOf(value.toLowerCase());
    return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
  }

  async function requestCredentialAction(action: AgentChatCredentialAction): Promise<void> {
    if (!providerSummary?.credential || credentialBusy) return;
    credentialBusy = true;
    credentialReceipt = null;
    credentialRequestSequence += 1;
    try {
      credentialReceipt = await requestAgentChatCredentialAction({
        request_id: `credential-action:${action}:${credentialRequestSequence}`,
        provider_instance_id: providerSummary.provider_instance_id,
        credential_ref: providerSummary.credential.credential_ref,
        action,
      });
    } finally {
      credentialBusy = false;
    }
  }

  function credentialMechanismLabel(): string {
    if (!providerSummary?.credential) return "Authentication";
    const credential = providerSummary.credential;
    if (credential.mechanism === "interactive_oauth"
      && credential.entitlement_metering === "subscription_allowance") {
      return "ChatGPT subscription · Interactive OAuth";
    }
    return `${label(credential.entitlement_metering.replaceAll("_", " "))} · ${label(credential.mechanism.replaceAll("_", " "))}`;
  }

  function credentialOutcomeLabel(receipt: AgentChatCredentialActionReceipt): string {
    if (receipt.outcome === "completed") {
      return `${label(receipt.action)} completed.`;
    }
    if (receipt.code === "provider_managed_lifecycle") {
      return `Codex owns ${receipt.action} for this login; no Nucleus setting changed.`;
    }
    return `${label(receipt.action)} was rejected without changing credential state.`;
  }
</script>

<div class="settings-page" data-testid="settings-agent-provider-page">
  <section class="provider-card" aria-label="Configured provider">
    <div>
      <Text weight="medium">{providerSummary?.display_name ?? "Configured provider"}</Text>
      {#if providerSummary}
        <Text tone="muted" size="sm">
          {providerSummary.harness_name}
        </Text>
      {/if}
    </div>
    <Text tone="muted" size="sm">
      {loadingCatalogue
        ? "Checking model availability…"
        : providerSummary?.model_catalogue_state === "available"
          ? `${modelCatalog.length} models available through provider-managed login`
          : "Model discovery unavailable; existing sessions are unchanged"}
    </Text>
    {#if providerSummary}
      <details class="provider-details">
        <summary>Technical details</summary>
        <dl>
          <div><dt>Instance</dt><dd>{providerSummary.provider_instance_id}</dd></div>
          <div><dt>Revision</dt><dd>{providerSummary.instance_revision}</dd></div>
          <div><dt>Driver</dt><dd>{providerSummary.driver_id}</dd></div>
          <div><dt>Facade</dt><dd>{providerSummary.protocol_facade_id}</dd></div>
        </dl>
      </details>
    {/if}
  </section>

  {#if providerCatalogue && shouldShowProviderSelector(providerCatalogue)}
    <section class="settings-field">
      <div>
        <Text weight="medium">Default provider</Text>
        <Text tone="muted" size="sm">Used when a new Agent Chat session is prepared.</Text>
      </div>
      <Select
        value={providerInstanceId}
        options={providerOptions}
        native={false}
        size="sm"
        ariaLabel="Default agent provider"
        disabled={context.busy}
        onValueChange={(value) => change({ providerInstanceId: value })}
      />
    </section>
  {/if}

  {#if providerSummary?.credential}
    <section class="credential-card" aria-label="Provider credential">
      <div>
        <Text weight="medium">{credentialMechanismLabel()}</Text>
        <Text tone="muted" size="sm">
          Provider-managed login · Nucleus stores no credential value or reference
        </Text>
      </div>
      <div class="credential-actions" aria-label="Credential actions">
        <Button
          variant="ghost"
          size="sm"
          disabled={credentialBusy}
          onClick={() => void requestCredentialAction("setup")}
        >Set up</Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={credentialBusy}
          onClick={() => void requestCredentialAction("repair")}
        >Repair</Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={credentialBusy}
          onClick={() => void requestCredentialAction("revoke")}
        >Revoke</Button>
      </div>
      {#if credentialReceipt}
        <Text tone="muted" size="sm">{credentialOutcomeLabel(credentialReceipt)}</Text>
      {:else}
        <Text tone="muted" size="sm">
          Credential lifecycle remains in Codex until a host-owned workflow is available.
        </Text>
      {/if}
    </section>
  {/if}

  {#if providerCatalogue && providerCatalogue.instances.length > 1}
    <section class="provider-inventory" aria-label="Provider instances">
      {#each providerCatalogue.instances as instance (instance.provider_instance_id)}
        <div class="provider-inventory-row">
          <Text size="sm">{instance.display_name}</Text>
          <Text tone="muted" size="xs">
            {instance.harness_name} · {instance.selection_readiness.replace("_", " ")}
          </Text>
        </div>
      {/each}
    </section>
  {/if}

  <section class="settings-field">
    <div>
      <Text weight="medium">Default model</Text>
      <Text tone="muted" size="sm">Used when a new Agent Chat session is prepared.</Text>
    </div>
    <Select
      value={modelRouteKey({ model, provider_id: providerId })}
      options={modelOptions}
      native={false}
      size="sm"
      ariaLabel="Default agent model"
      disabled={context.busy}
      onValueChange={(value) => change({ modelRoute: value })}
    />
  </section>

  <section class="settings-field">
    <div>
      <Text weight="medium">Default reasoning</Text>
      <Text tone="muted" size="sm">Limited to the selected model's discovered controls.</Text>
    </div>
    <Select
      value={reasoningEffort}
      options={reasoningOptions}
      native={false}
      size="sm"
      ariaLabel="Default reasoning effort"
      disabled={context.busy}
      onValueChange={(value) => change({ reasoningEffort: value })}
    />
  </section>

  <section class="settings-field">
    <div>
      <Text weight="medium">Default harness mode</Text>
      <Text tone="muted" size="sm">Mode changes open a newly prepared provider session.</Text>
    </div>
    <RadioGroup
      value={harnessMode}
      options={[
        { value: "normal", label: "Normal" },
        { value: "plan", label: "Plan" },
      ]}
      orientation="horizontal"
      ariaLabel="Default harness mode"
      disabled={context.busy}
      onValueChange={(value) => change({ harnessMode: value === "plan" ? "plan" : "normal" })}
    />
  </section>

  <Button
    variant="ghost"
    disabled={context.busy}
    onClick={() => void context.requestReset(AGENT_UNIT_ID, [
      DEFAULT_PROVIDER_INSTANCE_ENTRY_ID,
      DEFAULT_PROVIDER_ID_ENTRY_ID,
      DEFAULT_MODEL_ENTRY_ID,
      DEFAULT_REASONING_ENTRY_ID,
      DEFAULT_HARNESS_MODE_ENTRY_ID,
    ])}
  >
    Reset Agent defaults
  </Button>
</div>

<style>
  .settings-page,
  .settings-field,
  .provider-card,
  .credential-card {
    display: grid;
    gap: 1rem;
  }

  .provider-card,
  .credential-card {
    padding: 0.875rem;
    border: 1px solid var(--poodle-color-border-default);
    border-radius: var(--poodle-radius-surface);
  }

  .credential-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .provider-details { color: var(--poodle-color-text-secondary); font-size: 0.72rem; }
  .provider-details summary { width: fit-content; cursor: pointer; }
  .provider-details dl { display: grid; gap: 0.35rem; margin: 0.5rem 0 0; }
  .provider-details dl div { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: 0.5rem; }
  .provider-details dt { color: var(--poodle-color-text-tertiary); }
  .provider-details dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  .provider-inventory { display: grid; gap: 0.25rem; }
  .provider-inventory-row { display: grid; gap: 0.1rem; padding: 0.5rem 0; border-top: 1px solid var(--poodle-color-border-subtle); }
</style>
