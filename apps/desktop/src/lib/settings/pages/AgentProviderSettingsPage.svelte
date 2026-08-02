<script lang="ts">
  import { onMount } from "svelte";
  import { Button, RadioGroup, Select, Text } from "@poodle/svelte";
  import type { SettingsPageRenderContext } from "@longhorn/settings/svelte";
  import {
    loadAgentChatProviderSummary,
    requestAgentChatCredentialAction,
    type AgentChatCredentialAction,
    type AgentChatCredentialActionReceipt,
    type AgentChatModelOption,
    type AgentChatProviderSummary,
  } from "../../control/agentChat";
  import {
    AGENT_SCOPE_ID,
    AGENT_UNIT_ID,
    DEFAULT_HARNESS_MODE_ENTRY_ID,
    DEFAULT_MODEL_ENTRY_ID,
    DEFAULT_REASONING_ENTRY_ID,
  } from "../client";

  let { context }: { context: SettingsPageRenderContext } = $props();
  let modelCatalog = $state<AgentChatModelOption[]>([]);
  let providerSummary = $state<AgentChatProviderSummary | null>(null);
  let catalogStatus = $state<"loading" | "available" | "unavailable">("loading");
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
    modelCatalog.find((candidate) => candidate.model === model) ?? null,
  );
  const modelOptions = $derived.by(() => {
    const options = modelCatalog.map((candidate) => ({
      value: candidate.model,
      label: candidate.display_name,
    }));
    if (!options.some((option) => option.value === model)) {
      options.unshift({ value: model, label: `${model} (unavailable)` });
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
    void loadAgentChatProviderSummary()
      .then((summary) => {
        if (!current) return;
        providerSummary = summary;
        modelCatalog = summary.models;
        catalogStatus = summary.model_discovery;
      })
      .catch(() => {
        if (current) catalogStatus = "unavailable";
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

  function change(next: {
    model?: string;
    reasoningEffort?: string;
    harnessMode?: "normal" | "plan";
  }): void {
    const nextModel = next.model ?? model;
    const catalogModel = modelCatalog.find((candidate) => candidate.model === nextModel);
    void context.change(AGENT_UNIT_ID, {
      codecVersion: 1,
      value: {
        defaultModel: nextModel,
        defaultReasoningEffort: next.reasoningEffort
          ?? (next.model ? catalogModel?.default_reasoning_effort : null)
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
    if (!providerSummary || credentialBusy) return;
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
    if (!providerSummary) return "Authentication";
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
          {providerSummary.provider_instance_id} · {providerSummary.harness_name}
        </Text>
      {/if}
    </div>
    <Text tone="muted" size="sm">
      {catalogStatus === "loading"
        ? "Checking model availability…"
        : catalogStatus === "available"
          ? `${modelCatalog.length} models available through provider-managed login`
          : "Model discovery unavailable; existing sessions are unchanged"}
    </Text>
  </section>

  {#if providerSummary}
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

  <section class="settings-field">
    <div>
      <Text weight="medium">Default model</Text>
      <Text tone="muted" size="sm">Used when a new Agent Chat session is prepared.</Text>
    </div>
    <Select
      value={model}
      options={modelOptions}
      native={false}
      size="sm"
      ariaLabel="Default agent model"
      disabled={context.busy}
      onValueChange={(value) => change({ model: value })}
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
</style>
