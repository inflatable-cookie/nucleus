<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    queryProductWorkflowSummary,
    type ControlProductWorkflowGapDto,
    type ControlProductWorkflowSummaryDto,
    type ProductWorkflowSummaryQueryResult,
  } from "./control";

  type Props = {
    selectedProjectId?: string | null;
  };

  let { selectedProjectId = null }: Props = $props();

  const fallbackProjectId = "project:nucleus-local";

  let loading = $state(false);
  let result = $state<ProductWorkflowSummaryQueryResult | null>(null);
  let failure = $state<string | null>(null);

  const projectId = $derived(selectedProjectId ?? fallbackProjectId);
  const summary = $derived(result?.state === "record" ? result.summary : null);
  const totalRefs = $derived(summary ? sourceRefTotal(summary) : 0);
  const noEffects = $derived(summary ? noEffectFlags(summary).every((row) => !row[1]) : false);
  const statusLabel = $derived(
    loading
      ? "loading"
      : failure
        ? "error"
        : summary
          ? summary.next.source
          : (result?.state ?? "idle"),
  );
  const statusTone = $derived(
    loading ? "pending" : failure ? "danger" : noEffects ? "success" : "info",
  );
  const lanes = $derived(summary?.task_lanes.filter((lane) => lane.count > 0) ?? []);

  async function loadProductWorkflow() {
    loading = true;
    failure = null;

    try {
      result = await queryProductWorkflowSummary(projectId);
    } catch (error) {
      result = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function sourceRefTotal(record: ControlProductWorkflowSummaryDto) {
    const counts = record.source_counts;
    return (
      counts.task_candidates +
      counts.planning_sessions +
      counts.task_seeds +
      counts.accepted_planning_refs +
      counts.memory_proposals +
      counts.accepted_memories +
      counts.research_runs +
      counts.runtime_evidence_refs +
      counts.command_evidence_refs +
      counts.review_refs +
      counts.scm_readiness_refs
    );
  }

  function noEffectFlags(record: ControlProductWorkflowSummaryDto): [string, boolean][] {
    return [
      ["task mutation", record.no_effects.task_mutation_performed],
      ["provider run", record.no_effects.provider_execution_performed],
      ["provider write", record.no_effects.provider_write_performed],
      ["SCM or forge change", record.no_effects.scm_or_forge_mutation_performed],
      ["memory apply", record.no_effects.accepted_memory_apply_performed],
      ["projection write", record.no_effects.projection_write_performed],
      ["agent scheduling", record.no_effects.agent_scheduling_performed],
      ["UI state change", record.no_effects.ui_effect_performed],
    ];
  }

  function gapReason(gaps: ControlProductWorkflowGapDto[], area: string) {
    return gaps.find((gap) => gap.area === area)?.reason ?? "source refs present";
  }

  function nextSummary(record: ControlProductWorkflowSummaryDto) {
    return record.next.blocked_reason ?? (record.next.summary || "No next summary.");
  }

  function fallbackMessage(value: ProductWorkflowSummaryQueryResult | null) {
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
    void loadProductWorkflow();
  });
</script>

<Surface>
  <section class="product-workflow-proof-panel" aria-label="Product Workflow Proof">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Workflow proof</h2>
        <Text tone="muted">Read-only server summary.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if failure}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{failure}</Text>
      </div>
    {:else if loading}
      <div class="panel-message">
        <Text tone="muted">Loading workflow proof.</Text>
      </div>
    {:else if summary}
      <div class="workflow-identity">
        <div>
          <span>{summary.project.display_name ?? summary.project_id}</span>
          <small>{summary.project.status ?? "unknown"}</small>
        </div>
        <div>
          <span>{summary.gaps.length}</span>
          <small>gaps</small>
        </div>
        <div>
          <span>{totalRefs}</span>
          <small>source refs</small>
        </div>
        <div>
          <span>{noEffects ? "none" : "check"}</span>
          <small>effects</small>
        </div>
      </div>

      <div class="workflow-sections">
        <section>
          <h3>Tasks</h3>
          {#if lanes.length > 0}
            <ul>
              {#each lanes as lane}
                <li>
                  <strong>{lane.lane}</strong>
                  <span>{lane.count} tasks</span>
                  <small>{lane.task_refs.join(", ")}</small>
                </li>
              {/each}
            </ul>
          {:else}
            <Text tone="muted">{gapReason(summary.gaps, "tasks")}</Text>
          {/if}
        </section>

        <section>
          <h3>Context</h3>
          <dl>
            <div>
              <dt>Planning</dt>
              <dd>{summary.source_counts.planning_sessions + summary.source_counts.task_seeds}</dd>
            </div>
            <div>
              <dt>Memory</dt>
              <dd>{summary.source_counts.memory_proposals + summary.source_counts.accepted_memories}</dd>
            </div>
            <div>
              <dt>Research</dt>
              <dd>{summary.source_counts.research_runs}</dd>
            </div>
          </dl>
          <Text tone="muted">{gapReason(summary.gaps, "planning")}</Text>
        </section>

        <section>
          <h3>Runtime and review</h3>
          <dl>
            <div>
              <dt>Runtime</dt>
              <dd>{summary.source_counts.runtime_evidence_refs}</dd>
            </div>
            <div>
              <dt>Commands</dt>
              <dd>{summary.source_counts.command_evidence_refs}</dd>
            </div>
            <div>
              <dt>Review</dt>
              <dd>{summary.source_counts.review_refs}</dd>
            </div>
            <div>
              <dt>SCM</dt>
              <dd>{summary.source_counts.scm_readiness_refs}</dd>
            </div>
          </dl>
          <Text tone="muted">{gapReason(summary.gaps, "runtime")}</Text>
        </section>

        <section>
          <h3>Next</h3>
          <p>{nextSummary(summary)}</p>
          <small>{summary.next.next_ref ?? summary.next.source}</small>
        </section>
      </div>

      <div class="workflow-no-effects" aria-label="Product workflow no-effect flags">
        {#each noEffectFlags(summary) as [label, value]}
          <span class:flagged={value}>{label}: {value ? "true" : "false"}</span>
        {/each}
      </div>
    {:else}
      <div class="panel-message">
        <Text tone="muted">{fallbackMessage(result)}</Text>
      </div>
    {/if}

    <div class="panel-actions">
      <Text tone="muted">Read-only workflow.</Text>
      <Button variant="secondary" leadingIcon={refreshCw} onClick={loadProductWorkflow} disabled={loading}>
        Refresh
      </Button>
    </div>
  </section>
</Surface>

<style>
  .product-workflow-proof-panel {
    display: grid;
    gap: var(--poodle-space-stack-md);
    min-width: 0;
  }

  .workflow-identity {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .workflow-identity div,
  .workflow-sections section {
    min-width: 0;
    padding: 0.75rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-canvas);
  }

  .workflow-identity span {
    display: block;
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-size: 1.15rem;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workflow-identity small,
  .workflow-sections small,
  .workflow-sections span,
  .workflow-sections p,
  .workflow-sections dt,
  .workflow-sections dd,
  .workflow-no-effects span {
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .workflow-sections {
    display: grid;
    gap: 0.75rem;
  }

  .workflow-sections h3 {
    margin: 0 0 0.6rem;
    font-size: 0.85rem;
  }

  .workflow-sections ul,
  .workflow-sections dl {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .workflow-sections li,
  .workflow-sections dl div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.25rem 0.5rem;
    min-width: 0;
  }

  .workflow-sections strong,
  .workflow-sections span,
  .workflow-sections small,
  .workflow-sections p,
  .workflow-sections dt,
  .workflow-sections dd {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workflow-sections small,
  .workflow-sections p {
    grid-column: 1 / -1;
    margin: 0;
  }

  .workflow-no-effects {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .workflow-no-effects span {
    padding: 0.25rem 0.45rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
  }

  .workflow-no-effects .flagged {
    color: var(--poodle-color-text-danger);
  }
</style>
