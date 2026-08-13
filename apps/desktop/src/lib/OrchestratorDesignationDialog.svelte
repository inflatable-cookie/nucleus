<script lang="ts">
  import { onMount } from "svelte";
  import { Button, Dialog, Text } from "@inflatable-cookie/poodle-svelte";
  import type { ControlProjectRecordDto } from "./control";
  import { loadAgentChatProviderCatalogue, type AgentChatProviderCatalogue } from "./control/agentChat";
  import {
    designateOrchestrator,
    queryOrchestratorDesignations,
    revokeOrchestrator,
    type ControlDelegationActionDto,
  } from "./control/designations";
  import type { ControlOrchestratorDesignationDto } from "./control/generated/ControlOrchestratorDesignationDto";

  type Props = {
    open: boolean;
    project: ControlProjectRecordDto | null;
    onDesignationChanged: () => void;
  };

  let {
    open = $bindable(false),
    project,
    onDesignationChanged,
  }: Props = $props();

  let catalogue = $state<AgentChatProviderCatalogue | null>(null);
  let existing = $state<ControlOrchestratorDesignationDto | null>(null);
  let orchestratorInstance = $state("");
  let workerInstances = $state<string[]>([]);
  let workerModels = $state<string[]>([]);
  let concurrentBudget = $state("2");
  let tokenBudget = $state("");
  let timeBudgetSeconds = $state("");
  let allowedActions = $state<ControlDelegationActionDto[]>([
    "delegate",
    "run_status",
    "cancel_run",
    "accept_delivery",
    "reject_delivery",
  ]);
  let steeringPermitted = $state(false);
  let pending = $state(false);
  let failure = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let initializedProjectId = $state<string | null>(null);

  const actionOptions: Array<{ value: ControlDelegationActionDto; label: string }> = [
    { value: "delegate", label: "delegate" },
    { value: "run_status", label: "run_status" },
    { value: "cancel_run", label: "cancel_run" },
    { value: "accept_delivery", label: "accept_delivery" },
    { value: "reject_delivery", label: "reject_delivery" },
  ];

  const readyInstances = $derived(
    catalogue?.instances.filter((instance) => instance.selection_readiness === "ready") ?? [],
  );
  const toolCapableInstances = $derived(
    readyInstances.filter((instance) => instance.tool_capable),
  );
  const toolIncapableInstances = $derived(
    readyInstances.filter((instance) => !instance.tool_capable),
  );
  const orchestratorOptions = $derived(
    toolCapableInstances.map((instance) => ({
      value: instance.provider_instance_id,
      label: instance.display_name,
    })),
  );
  const workerModelOptions = $derived.by(() => {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string }> = [];
    for (const instance of readyInstances) {
      if (!workerInstances.includes(instance.provider_instance_id)) continue;
      for (const model of instance.models) {
        if (seen.has(model.model)) continue;
        seen.add(model.model);
        options.push({ value: model.model, label: model.display_name });
      }
    }
    return options;
  });

  $effect(() => {
    if (!open || !project || initializedProjectId === project.project_id) return;
    initializedProjectId = project.project_id;
    void reset();
  });

  async function reset(): Promise<void> {
    failure = null;
    notice = null;
    pending = false;
    existing = null;
    orchestratorInstance = "";
    workerInstances = [];
    workerModels = [];
    concurrentBudget = "2";
    tokenBudget = "";
    timeBudgetSeconds = "";
    allowedActions = [
      "delegate",
      "run_status",
      "cancel_run",
      "accept_delivery",
      "reject_delivery",
    ];
    steeringPermitted = false;
    try {
      catalogue ??= await loadAgentChatProviderCatalogue();
      if (!project) return;
      const query = await queryOrchestratorDesignations(project.project_id);
      if (query.state === "record" && query.designations.length > 0) {
        existing = query.designations[0];
        orchestratorInstance = existing.orchestrator_provider_instance;
        workerInstances = existing.allowed_worker_provider_instances ?? readyInstances.map((i) => i.provider_instance_id);
        workerModels = existing.allowed_worker_models ?? [];
        concurrentBudget = String(existing.concurrent_run_budget);
        tokenBudget = existing.per_run_token_budget === null ? "" : String(existing.per_run_token_budget);
        timeBudgetSeconds = existing.per_run_time_budget_seconds === null
          ? ""
          : String(existing.per_run_time_budget_seconds);
        allowedActions = existing.allowed_actions;
        steeringPermitted = existing.steering_permitted;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  function parseBudget(value: string): bigint | null {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? BigInt(parsed) : null;
  }

  function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  function toggleAction(value: ControlDelegationActionDto): void {
    allowedActions = allowedActions.includes(value)
      ? allowedActions.filter((action) => action !== value)
      : [...allowedActions, value];
  }

  async function designate(): Promise<void> {
    if (!project || pending) return;
    if (!orchestratorInstance) {
      failure = "Select an orchestrator provider instance (tool-capable routes only).";
      return;
    }
    if (workerInstances.length === 0) {
      failure = "Allow at least one worker provider instance, or clear the allowlist.";
      return;
    }
    pending = true;
    failure = null;
    notice = null;
    try {
      const result = await designateOrchestrator({
        designationId: `designation:${project.project_id}:${orchestratorInstance}`,
        projectId: project.project_id,
        orchestratorProviderInstance: orchestratorInstance,
        allowedWorkerProviderInstances: workerInstances.length === readyInstances.length ? null : workerInstances,
        allowedWorkerModels: workerModels.length === 0 ? null : workerModels,
        concurrentRunBudget: parseBudget(concurrentBudget) ?? 2n,
        perRunTokenBudget: parseBudget(tokenBudget),
        perRunTimeBudgetSeconds: parseBudget(timeBudgetSeconds),
        allowedActions,
        steeringPermitted,
        expectedRevision: existing?.revision_id ?? null,
      });
      if (result.state === "accepted") {
        notice = existing ? "Envelope updated." : "Designated. The orchestrator session receives the delegation verbs on its next session.";
        onDesignationChanged();
        await reset();
      } else {
        failure = result.reason;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      pending = false;
    }
  }

  async function revoke(): Promise<void> {
    if (!project || !existing || pending) return;
    pending = true;
    failure = null;
    notice = null;
    try {
      const result = await revokeOrchestrator(existing.designation_id, existing.revision_id);
      if (result.state === "accepted") {
        notice = "Designation revoked. Running work is untouched; new delegation is blocked.";
        onDesignationChanged();
        await reset();
      } else {
        failure = result.reason;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      pending = false;
    }
  }

  onMount(() => {
    void loadAgentChatProviderCatalogue()
      .then((loaded) => {
        catalogue = loaded;
      })
      .catch((error) => {
        failure = error instanceof Error ? error.message : String(error);
      });
  });
</script>

<Dialog
  bind:open
  title="Designate a project orchestrator"
  description={project ? `Grant orchestration authority in ${project.display_name}.` : "Select a project first."}
  width="md"
  size="md"
  showCloseButton
>
  <form class="designation-form" onsubmit={(event) => { event.preventDefault(); void designate(); }}>
    {#if existing}
      <Text tone="muted" size="xs">
        Active designation for {existing.orchestrator_provider_instance} · {existing.status}.
        Re-designating replaces the envelope; revocation blocks new delegation without cancelling running work.
      </Text>
    {/if}
    <label>
      <span>Orchestrator provider instance <small>(tool-capable routes only)</small></span>
      <select bind:value={orchestratorInstance}>
        <option value="" disabled>Select an instance</option>
        {#each orchestratorOptions as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
      {#if toolIncapableInstances.length > 0}
        <small class="refused">
          Refused routes (no consumer tool exchange, contract 041):{" "}
          {toolIncapableInstances.map((instance) => `${instance.display_name} — ${instance.tool_capable_reason}`).join("; ")}
        </small>
      {/if}
    </label>
    <label>
      <span>Allowed worker provider instances <small>(unchecked = all ready instances)</small></span>
      <div class="check-list">
        {#each readyInstances as instance}
          <label class="check">
            <input
              type="checkbox"
              checked={workerInstances.includes(instance.provider_instance_id)}
              onchange={() => (workerInstances = toggle(workerInstances, instance.provider_instance_id))}
            />
            {instance.display_name}
          </label>
        {/each}
      </div>
    </label>
    <label>
      <span>Allowed worker models <small>(empty = unconstrained)</small></span>
      <div class="check-list">
        {#each workerModelOptions as option}
          <label class="check">
            <input
              type="checkbox"
              checked={workerModels.includes(option.value)}
              onchange={() => (workerModels = toggle(workerModels, option.value))}
            />
            {option.label}
          </label>
        {/each}
        {#if workerModelOptions.length === 0}
          <small>Select worker provider instances to list their models.</small>
        {/if}
      </div>
    </label>
    <div class="field-row">
      <label>
        <span>Concurrent-run budget</span>
        <input bind:value={concurrentBudget} inputmode="numeric" placeholder="2" />
      </label>
      <label>
        <span>Per-run token budget <small>(optional)</small></span>
        <input bind:value={tokenBudget} inputmode="numeric" placeholder="100000" />
      </label>
      <label>
        <span>Per-run time budget seconds <small>(optional)</small></span>
        <input bind:value={timeBudgetSeconds} inputmode="numeric" placeholder="3600" />
      </label>
    </div>
    <label>
      <span>Allowed delegation actions <small>(deny-by-default)</small></span>
      <div class="check-list">
        {#each actionOptions as option}
          <label class="check">
            <input
              type="checkbox"
              checked={allowedActions.includes(option.value)}
              onchange={() => toggleAction(option.value)}
            />
            {option.label}
          </label>
        {/each}
      </div>
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={steeringPermitted} />
      <span>Worker steering permitted <small>(recorded; message_run lands in phase 4)</small></span>
    </label>
    <Text tone="muted" size="xs">
      Designation binds this provider instance to the project: its sessions gain the
      delegation verbs (delegate, run_status, cancel_run, accept_delivery, reject_delivery),
      each call validated against this envelope before dispatch. Grants are deny-by-default.
    </Text>
    {#if notice}
      <div role="status"><Text tone="muted" size="xs">{notice}</Text></div>
    {/if}
    {#if failure}
      <div role="alert"><Text tone="danger" size="xs">{failure}</Text></div>
    {/if}
    <div class="actions">
      {#if existing}
        <Button variant="secondary" size="sm" type="button" disabled={pending} onClick={() => void revoke()}>
          {pending ? "Working…" : "Revoke designation"}
        </Button>
      {/if}
      <Button variant="secondary" size="sm" type="button" onClick={() => (open = false)}>Cancel</Button>
      <Button variant="primary" size="sm" type="submit" disabled={pending || !project}>
        {pending ? "Saving…" : existing ? "Update designation" : "Designate orchestrator"}
      </Button>
    </div>
  </form>
</Dialog>

<style>
  .designation-form {
    display: grid;
    gap: 0.75rem;
  }

  label {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
  }

  label > span {
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
    font-weight: 600;
  }

  small {
    color: var(--poodle-color-text-muted);
    font-weight: 400;
  }

  .refused {
    color: var(--poodle-color-text-muted);
    font-size: 0.68rem;
  }

  input,
  select {
    box-sizing: border-box;
    width: 100%;
    padding: 0.45rem 0.55rem;
    color: var(--poodle-color-text-primary);
    border: 1px solid var(--poodle-color-border-default);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
    font: inherit;
    font-size: 0.8125rem;
  }

  .check-list {
    display: grid;
    gap: 0.3rem;
    max-height: 9rem;
    overflow: auto;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--poodle-color-border-default);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
  }

  .check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.78rem;
    color: var(--poodle-color-text-primary);
  }

  .check input {
    width: auto;
    padding: 0;
  }

  .field-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
</style>
