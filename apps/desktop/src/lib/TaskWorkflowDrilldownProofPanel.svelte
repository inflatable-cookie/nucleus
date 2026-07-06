<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    queryTaskWorkflowDrilldown,
    type ControlTaskRecordDto,
    type ControlTaskWorkflowDrilldownDto,
    type ControlTaskWorkflowGapDto,
    type TaskWorkflowDrilldownQueryResult,
  } from "./control";

  type Props = {
    selectedTask: ControlTaskRecordDto | null;
  };

  let { selectedTask }: Props = $props();

  const fallbackProjectId = "project:nucleus-local";
  const fallbackTaskId = "task:nucleus-local:bootstrap";

  let loading = $state(false);
  let result = $state<TaskWorkflowDrilldownQueryResult | null>(null);
  let failure = $state<string | null>(null);

  const projectId = $derived(selectedTask?.project_id ?? fallbackProjectId);
  const taskId = $derived(selectedTask?.task_id ?? fallbackTaskId);
  const drilldown = $derived(result?.state === "record" ? result.drilldown : null);
  const noEffects = $derived(drilldown ? noEffectFlags(drilldown).every((row) => !row[1]) : false);
  const statusLabel = $derived(
    loading
      ? "loading"
      : failure
        ? "error"
        : drilldown
          ? drilldown.next.source
          : (result?.state ?? "idle"),
  );
  const statusTone = $derived(
    loading ? "pending" : failure ? "danger" : noEffects ? "success" : "info",
  );

  async function loadDrilldown() {
    loading = true;
    failure = null;

    try {
      result = await queryTaskWorkflowDrilldown(projectId, taskId);
    } catch (error) {
      result = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function noEffectFlags(record: ControlTaskWorkflowDrilldownDto): [string, boolean][] {
    return [
      ["task mutation", record.no_effects.task_mutation_performed],
      ["provider run", record.no_effects.provider_execution_performed],
      ["provider write", record.no_effects.provider_write_performed],
      ["SCM or forge change", record.no_effects.scm_or_forge_mutation_performed],
      ["memory apply", record.no_effects.accepted_memory_apply_performed],
      ["planning apply", record.no_effects.planning_apply_performed],
      ["projection write", record.no_effects.projection_write_performed],
      ["agent scheduling", record.no_effects.agent_scheduling_performed],
      ["UI state change", record.no_effects.ui_effect_performed],
    ];
  }

  function gapReason(gaps: ControlTaskWorkflowGapDto[], area: string) {
    return (
      gaps.find((gap) => gap.area === area || gap.area === `${area}_missing`)?.reason ??
      "source refs present"
    );
  }

  function fallbackMessage(value: TaskWorkflowDrilldownQueryResult | null) {
    if (!value) {
      return "No response.";
    }

    switch (value.state) {
      case "record":
        return null;
      case "empty":
        return "No records.";
      case "unsupported":
        return value.reason;
      case "error":
        return `${value.kind}: ${value.reason}`;
      case "unexpected":
        return value.reason;
    }
  }

  $effect(() => {
    void projectId;
    void taskId;
    void loadDrilldown();
  });
</script>

<Surface>
  <section class="task-workflow-drilldown-proof-panel" aria-label="Task Workflow Drilldown Proof">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Task workflow</h2>
        <Text tone="muted">Read-only selected task drilldown.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if failure}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{failure}</Text>
      </div>
    {:else if loading}
      <div class="panel-message">
        <Text tone="muted">Loading task workflow.</Text>
      </div>
    {:else if drilldown}
      <div class="drilldown-identity">
        <div>
          <span>{drilldown.task?.title ?? drilldown.task_id}</span>
          <small>{drilldown.task?.activity ?? "missing task"}</small>
        </div>
        <div>
          <span>{drilldown.readiness?.lane ?? "none"}</span>
          <small>lane</small>
        </div>
        <div>
          <span>{drilldown.gaps.length}</span>
          <small>gaps</small>
        </div>
        <div>
          <span>{noEffects ? "none" : "check"}</span>
          <small>effects</small>
        </div>
      </div>

      <div class="drilldown-sections">
        <section>
          <h3>Timeline</h3>
          <p>{drilldown.source_counts.timeline_entry_refs} entries</p>
          <small>{gapReason(drilldown.gaps, "timeline")}</small>
        </section>

        <section>
          <h3>Runtime</h3>
          <dl>
            <div>
              <dt>Receipts</dt>
              <dd>{drilldown.runtime.runtime_receipt_refs.length}</dd>
            </div>
            <div>
              <dt>Commands</dt>
              <dd>{drilldown.runtime.command_evidence_refs.length}</dd>
            </div>
            <div>
              <dt>Completions</dt>
              <dd>{drilldown.runtime.task_completion_refs.length}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>Review and SCM</h3>
          <dl>
            <div>
              <dt>Reviews</dt>
              <dd>{drilldown.review.review_refs.length}</dd>
            </div>
            <div>
              <dt>Handoffs</dt>
              <dd>{drilldown.scm_handoff.handoff_refs.length}</dd>
            </div>
          </dl>
          <small>{gapReason(drilldown.gaps, "scm_handoff")}</small>
        </section>

        <section>
          <h3>Next</h3>
          <p>{drilldown.next.blocked_reason ?? drilldown.next.summary}</p>
          <small>{drilldown.next.next_ref ?? drilldown.next.source}</small>
        </section>
      </div>

      {#if drilldown.work_progress.work_items.length > 0}
        <div class="work-items" aria-label="Task workflow work items">
          {#each drilldown.work_progress.work_items as item}
            <div>
              <strong>{item.work_item_ref}</strong>
              <span>{item.runtime_status} / {item.review_status}</span>
              <small>
                receipts {item.receipt_refs.length}, checkpoints {item.checkpoint_refs.length},
                diffs {item.diff_summary_refs.length}
              </small>
            </div>
          {/each}
        </div>
      {:else}
        <div class="panel-message">
          <Text tone="muted">{gapReason(drilldown.gaps, "work_progress")}</Text>
        </div>
      {/if}

      <div class="drilldown-no-effects" aria-label="Task workflow no-effect flags">
        {#each noEffectFlags(drilldown) as [label, value]}
          <span class:flagged={value}>{label}: {value ? "true" : "false"}</span>
        {/each}
      </div>
    {:else}
      <div class="panel-message">
        <Text tone="muted">{fallbackMessage(result)}</Text>
      </div>
    {/if}

    <div class="panel-actions">
      <Text tone="muted">{selectedTask ? selectedTask.task_id : "Bootstrap task"}</Text>
      <Button variant="secondary" leadingIcon={refreshCw} onClick={loadDrilldown} disabled={loading}>
        Refresh
      </Button>
    </div>
  </section>
</Surface>

<style>
  .task-workflow-drilldown-proof-panel {
    display: grid;
    gap: var(--poodle-space-stack-md);
    min-width: 0;
  }

  .drilldown-identity,
  .drilldown-sections {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .drilldown-identity div,
  .drilldown-sections section,
  .work-items div {
    min-width: 0;
    padding: 0.75rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-background-canvas);
  }

  .drilldown-identity span,
  .work-items strong {
    display: block;
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .drilldown-identity small,
  .drilldown-sections small,
  .work-items small {
    display: block;
    overflow: hidden;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .drilldown-sections h3 {
    margin: 0 0 0.5rem;
    color: var(--poodle-color-text-primary);
    font-size: 0.8125rem;
    letter-spacing: 0;
  }

  .drilldown-sections p {
    margin: 0 0 0.35rem;
    color: var(--poodle-color-text-primary);
  }

  .drilldown-sections dl {
    display: grid;
    gap: 0.35rem;
    margin: 0 0 0.5rem;
  }

  .drilldown-sections dl div {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .drilldown-sections dt,
  .drilldown-sections dd {
    margin: 0;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .work-items {
    display: grid;
    gap: 0.5rem;
  }

  .work-items div {
    display: grid;
    gap: 0.25rem;
  }

  .work-items span {
    color: var(--poodle-color-text-secondary);
    font-size: 0.8rem;
  }

  .drilldown-no-effects {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .drilldown-no-effects span {
    padding: 0.25rem 0.45rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.72rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-canvas);
  }

  .drilldown-no-effects span.flagged {
    color: var(--poodle-color-status-danger);
    border-color: var(--poodle-color-status-danger);
  }

  @media (max-width: 980px) {
    .drilldown-identity,
    .drilldown-sections {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
