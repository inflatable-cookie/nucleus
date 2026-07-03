<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    queryMemoryProposals,
    queryPlanningSessions,
    queryResearchRunBriefs,
    type MemoryProposalsQueryResult,
    type PlanningSessionsQueryResult,
    type ResearchRunBriefsQueryResult,
  } from "./control";

  const projectId = "project:nucleus-local";

  let loading = $state(false);
  let planning = $state<PlanningSessionsQueryResult | null>(null);
  let memory = $state<MemoryProposalsQueryResult | null>(null);
  let research = $state<ResearchRunBriefsQueryResult | null>(null);
  let failure = $state<string | null>(null);

  const planningRecords = $derived(planning?.state === "records" ? planning : null);
  const memoryRecords = $derived(memory?.state === "records" ? memory : null);
  const researchRecords = $derived(research?.state === "records" ? research : null);
  const totalRecords = $derived(
    (planningRecords?.sessions.length ?? 0) +
      (memoryRecords?.proposals.length ?? 0) +
      (researchRecords?.runs.length ?? 0),
  );
  const noEffect = $derived(
    Boolean(
      planningRecords &&
        memoryRecords &&
        researchRecords &&
        !planningRecords.client_can_mutate &&
        !memoryRecords.client_can_mutate &&
        !researchRecords.client_can_mutate &&
        !planningRecords.provider_execution_available &&
        !memoryRecords.provider_execution_available &&
        !researchRecords.provider_execution_available,
    ),
  );
  const statusLabel = $derived(
    loading ? "loading" : failure ? "error" : totalRecords > 0 ? "read-only" : "empty",
  );
  const statusTone = $derived(
    loading ? "pending" : failure ? "danger" : noEffect ? "success" : "info",
  );

  async function loadPlanningResearch() {
    loading = true;
    failure = null;

    try {
      const [planningResult, memoryResult, researchResult] = await Promise.all([
        queryPlanningSessions(projectId),
        queryMemoryProposals(projectId),
        queryResearchRunBriefs(projectId),
      ]);
      planning = planningResult;
      memory = memoryResult;
      research = researchResult;
    } catch (error) {
      planning = null;
      memory = null;
      research = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function resultMessage(
    result: PlanningSessionsQueryResult | MemoryProposalsQueryResult | ResearchRunBriefsQueryResult | null,
  ) {
    if (!result) {
      return "No response.";
    }
    switch (result.state) {
      case "records":
        return null;
      case "empty":
        return "No records.";
      case "unsupported":
        return result.reason;
      case "error":
        return `${result.kind}: ${result.reason}`;
      case "unexpected":
        return result.reason;
    }
  }

  $effect(() => {
    void loadPlanningResearch();
  });
</script>

<Surface>
  <section class="planning-research-proof-panel" aria-label="Planning Research Proof">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Planning proof</h2>
        <Text tone="muted">Read-only planning, memory, and research summaries.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if failure}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{failure}</Text>
      </div>
    {:else if loading}
      <div class="panel-message">
        <Text tone="muted">Loading planning proof.</Text>
      </div>
    {:else}
      <div class="planning-proof-counts" aria-label="Planning proof counts">
        <div>
          <span>{planningRecords?.sessions.length ?? 0}</span>
          <small>sessions</small>
        </div>
        <div>
          <span>{memoryRecords?.proposals.length ?? 0}</span>
          <small>memories</small>
        </div>
        <div>
          <span>{researchRecords?.runs.length ?? 0}</span>
          <small>research</small>
        </div>
        <div>
          <span>{noEffect ? "no" : "check"}</span>
          <small>effects</small>
        </div>
      </div>

      <div class="planning-proof-grid">
        <section>
          <h3>Planning</h3>
          {#if planningRecords}
            <ul>
              {#each planningRecords.sessions as session}
                <li>
                  <strong>{session.kind}</strong>
                  <span>{session.status}</span>
                  <small>{session.output_refs.task_seed_refs.length} task seeds</small>
                </li>
              {/each}
            </ul>
          {:else}
            <Text tone="muted">{resultMessage(planning)}</Text>
          {/if}
        </section>

        <section>
          <h3>Memory</h3>
          {#if memoryRecords}
            <ul>
              {#each memoryRecords.proposals as proposal}
                <li>
                  <strong>{proposal.kind}</strong>
                  <span>{proposal.review_status}</span>
                  <small>{proposal.source_ref_count} sources</small>
                </li>
              {/each}
            </ul>
          {:else}
            <Text tone="muted">{resultMessage(memory)}</Text>
          {/if}
        </section>

        <section>
          <h3>Research</h3>
          {#if researchRecords}
            <ul>
              {#each researchRecords.runs as run}
                <li>
                  <strong>{run.status}</strong>
                  <span>{run.question_count} questions</span>
                  <small>{run.gap_ref_count} gaps</small>
                </li>
              {/each}
            </ul>
          {:else}
            <Text tone="muted">{resultMessage(research)}</Text>
          {/if}
        </section>
      </div>
    {/if}

    <div class="panel-actions">
      <Text tone="muted">Read-only inspection.</Text>
      <Button variant="secondary" leadingIcon={refreshCw} onClick={loadPlanningResearch} disabled={loading}>
        Refresh
      </Button>
    </div>
  </section>
</Surface>

<style>
  .planning-research-proof-panel {
    display: grid;
    gap: var(--poodle-space-stack-md);
    min-width: 0;
  }

  .planning-proof-counts {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .planning-proof-counts div,
  .planning-proof-grid section {
    min-width: 0;
    padding: 0.75rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-canvas);
  }

  .planning-proof-counts span {
    display: block;
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-size: 1.25rem;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .planning-proof-counts small,
  .planning-proof-grid small,
  .planning-proof-grid span {
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .planning-proof-grid {
    display: grid;
    gap: 0.75rem;
  }

  .planning-proof-grid h3 {
    margin: 0 0 0.6rem;
    font-size: 0.85rem;
  }

  .planning-proof-grid ul {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .planning-proof-grid li {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .planning-proof-grid strong,
  .planning-proof-grid span,
  .planning-proof-grid small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
