<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { Button, Dialog, Text } from "@inflatable-cookie/poodle-svelte";
  import type { ControlProjectRecordDto } from "./control";
  import type { AgentChatDefaults } from "./settings/client";

  type RunDispatchOutcome = {
    run_id: string;
    conversation_id: string;
    worktree_slug: string;
    branch_ref: string;
  };

  type Props = {
    open: boolean;
    project: ControlProjectRecordDto | null;
    agentChatDefaults: AgentChatDefaults;
    onDispatched: (outcome: RunDispatchOutcome) => void;
  };

  let {
    open = $bindable(false),
    project,
    agentChatDefaults,
    onDispatched,
  }: Props = $props();

  let slug = $state("run");
  let objective = $state("");
  let acceptance = $state("");
  let stopConditions = $state("");
  let providerInstance = $state("");
  let model = $state("");
  let tokenBudget = $state("");
  let timeBudgetSeconds = $state("");
  let pending = $state(false);
  let failure = $state<string | null>(null);
  let initializedProjectId = $state<string | null>(null);

  $effect(() => {
    if (!open || !project || initializedProjectId === project.project_id) return;
    initializedProjectId = project.project_id;
    providerInstance = agentChatDefaults.providerInstanceId;
    model = agentChatDefaults.model;
    slug = "run";
    objective = "";
    acceptance = "";
    stopConditions = "";
    tokenBudget = "";
    timeBudgetSeconds = "";
    failure = null;
  });

  function lines(value: string): string[] {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async function dispatch(): Promise<void> {
    if (!project || pending) return;
    if (!slug.trim() || !objective.trim() || !providerInstance.trim() || !model.trim()) {
      failure = "Slug, objective, provider instance, and model are required.";
      return;
    }

    pending = true;
    failure = null;
    try {
      const outcome = await invoke<RunDispatchOutcome>("dispatch_run", {
        request: {
          project_id: project.project_id,
          slug: slug.trim(),
          objective_scope: objective.trim(),
          acceptance: lines(acceptance),
          stop_conditions: lines(stopConditions),
          provider_instance: providerInstance.trim(),
          provider_model: model.trim(),
          token_budget: parseBudget(tokenBudget),
          time_budget_seconds: parseBudget(timeBudgetSeconds),
          operator_ref: "operator:desktop",
        },
      });
      open = false;
      onDispatched(outcome);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      pending = false;
    }
  }

  function parseBudget(value: string): number | null {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
</script>

<Dialog
  bind:open
  title="Dispatch a worker run"
  description={project ? `Create an isolated worktree for ${project.display_name}.` : "Select a project first."}
  width="md"
  size="sm"
  showCloseButton
>
  <form class="dispatch-form" onsubmit={(event) => { event.preventDefault(); void dispatch(); }}>
    <label>
      <span>Worktree slug</span>
      <input bind:value={slug} placeholder="run-name" autocomplete="off" />
    </label>
    <label>
      <span>Objective and scope</span>
      <textarea bind:value={objective} rows="4" placeholder="What should the worker deliver?"></textarea>
    </label>
    <label>
      <span>Acceptance criteria <small>(one per line)</small></span>
      <textarea bind:value={acceptance} rows="3" placeholder="Tests pass"></textarea>
    </label>
    <label>
      <span>Stop conditions <small>(one per line)</small></span>
      <textarea bind:value={stopConditions} rows="3" placeholder="Stop if authority is unclear"></textarea>
    </label>
    <div class="field-row">
      <label>
        <span>Provider instance</span>
        <input bind:value={providerInstance} placeholder="codex:local-default" />
      </label>
      <label>
        <span>Model</span>
        <input bind:value={model} placeholder="gpt-5.4-mini" />
      </label>
    </div>
    <div class="field-row">
      <label>
        <span>Token budget <small>(optional)</small></span>
        <input bind:value={tokenBudget} inputmode="numeric" placeholder="100000" />
      </label>
      <label>
        <span>Time budget seconds <small>(optional)</small></span>
        <input bind:value={timeBudgetSeconds} inputmode="numeric" placeholder="3600" />
      </label>
    </div>
    <Text tone="muted" size="xs">
      Confirming writes the durable worktree authority intent, runs the gated
      worktree creation, and starts the worker conversation.
    </Text>
    {#if failure}
      <div role="alert"><Text tone="danger" size="xs">{failure}</Text></div>
    {/if}
    <div class="actions">
      <Button variant="secondary" size="sm" type="button" onClick={() => (open = false)}>Cancel</Button>
      <Button variant="primary" size="sm" type="submit" disabled={pending || !project}>
        {pending ? "Dispatching…" : "Confirm dispatch"}
      </Button>
    </div>
  </form>
</Dialog>

<style>
  .dispatch-form {
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

  input,
  textarea {
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

  textarea {
    resize: vertical;
  }

  input:focus,
  textarea:focus {
    outline: 2px solid var(--poodle-color-border-focus);
    outline-offset: 1px;
  }

  .field-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
</style>
