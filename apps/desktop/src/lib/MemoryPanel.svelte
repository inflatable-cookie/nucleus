<script lang="ts">
  import { IconButton, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    queryAcceptedMemory,
    queryMemoryProposals,
    type AcceptedMemoryQueryResult,
    type ControlAcceptedMemorySummaryDto,
    type ControlMemoryProposalSummaryDto,
    type MemoryProposalsQueryResult,
  } from "./control";

  let { projectId }: { projectId: string | null } = $props();

  let loading = $state(false);
  let failure = $state<string | null>(null);
  let memories = $state<ControlAcceptedMemorySummaryDto[]>([]);
  let proposals = $state<ControlMemoryProposalSummaryDto[]>([]);
  let loadVersion = 0;

  $effect(() => {
    void loadMemory(projectId);
  });

  async function loadMemory(selectedProjectId: string | null): Promise<void> {
    const version = ++loadVersion;
    failure = null;
    memories = [];
    proposals = [];
    if (!selectedProjectId) {
      loading = false;
      return;
    }

    loading = true;
    try {
      const [accepted, proposed] = await Promise.all([
        queryAcceptedMemory(selectedProjectId),
        queryMemoryProposals(selectedProjectId),
      ]);
      if (version !== loadVersion) return;
      memories = recordsFromAccepted(accepted);
      proposals = recordsFromProposals(proposed);
    } catch (caught) {
      if (version === loadVersion) failure = formatError(caught);
    } finally {
      if (version === loadVersion) loading = false;
    }
  }

  function recordsFromAccepted(result: AcceptedMemoryQueryResult): ControlAcceptedMemorySummaryDto[] {
    if (result.state === "records") return result.memories;
    if (result.state === "empty") return [];
    throw new Error(queryFailure("Accepted memory", result));
  }

  function recordsFromProposals(result: MemoryProposalsQueryResult): ControlMemoryProposalSummaryDto[] {
    if (result.state === "records") return result.proposals;
    if (result.state === "empty") return [];
    throw new Error(queryFailure("Memory proposals", result));
  }

  function queryFailure(
    label: string,
    result: Exclude<AcceptedMemoryQueryResult | MemoryProposalsQueryResult, { state: "records" } | { state: "empty" }>,
  ): string {
    return `${label}: ${result.reason}`;
  }

  function formatLabel(value: string): string {
    return value.replaceAll("_", " ");
  }

  function formatError(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }
</script>

<section class="memory-panel" aria-label="Memory">
  <header class="memory-header">
    <div>
      <h1>Memory</h1>
      <Text size="sm" tone="muted">
        {memories.length} accepted · {proposals.length} proposed
      </Text>
    </div>
    <IconButton
      variant="ghost"
      size="sm"
      icon={refreshCw}
      ariaLabel="Refresh project memory"
      tooltip="Refresh project memory"
      onClick={() => loadMemory(projectId)}
      disabled={loading || !projectId}
    />
  </header>

  {#if failure}
    <div class="panel-message panel-error" role="alert">{failure}</div>
  {:else if !projectId}
    <div class="panel-message">
      <Text weight="semibold">No project selected</Text>
      <Text tone="muted">Select a project to inspect its shared memory.</Text>
    </div>
  {:else if loading}
    <div class="panel-message"><Text tone="muted">Loading memory…</Text></div>
  {:else}
    <div class="memory-content">
      <section class="memory-group" aria-labelledby="accepted-memory-heading">
        <div class="group-heading">
          <h2 id="accepted-memory-heading">Accepted</h2>
          <span>{memories.length}</span>
        </div>
        {#if memories.length === 0}
          <div class="group-empty"><Text size="sm" tone="muted">No accepted project memory.</Text></div>
        {:else}
          <div class="record-list">
            {#each memories as memory (memory.memory_id)}
              <details class="memory-record">
                <summary>
                  <span class="record-id">{memory.memory_id}</span>
                  <span class="record-meta">{formatLabel(memory.kind)} · {formatLabel(memory.scope)}</span>
                </summary>
                <dl>
                  <div><dt>Status</dt><dd>{formatLabel(memory.status)}</dd></div>
                  <div><dt>Confidence</dt><dd>{formatLabel(memory.confidence)}</dd></div>
                  <div><dt>Sensitivity</dt><dd>{formatLabel(memory.sensitivity)}</dd></div>
                  <div><dt>Retention</dt><dd>{formatLabel(memory.retention)}</dd></div>
                  <div><dt>Sources</dt><dd>{memory.source_ref_count}</dd></div>
                  <div><dt>Evidence</dt><dd>{memory.evidence_ref_count}</dd></div>
                </dl>
                <div class="actor-refs">
                  <code>accepted by {memory.accepted_by_ref}</code>
                  <code>reviewed by {memory.reviewer_ref}</code>
                </div>
              </details>
            {/each}
          </div>
        {/if}
      </section>

      <section class="memory-group" aria-labelledby="proposed-memory-heading">
        <div class="group-heading">
          <h2 id="proposed-memory-heading">Proposed</h2>
          <span>{proposals.length}</span>
        </div>
        {#if proposals.length === 0}
          <div class="group-empty"><Text size="sm" tone="muted">No proposals awaiting review.</Text></div>
        {:else}
          <div class="record-list">
            {#each proposals as proposal (proposal.proposal_id)}
              <details class="memory-record proposal-record">
                <summary>
                  <span class="record-id">{proposal.proposal_id}</span>
                  <span class="record-meta">{formatLabel(proposal.kind)} · {formatLabel(proposal.scope)}</span>
                </summary>
                <dl>
                  <div><dt>Status</dt><dd>{formatLabel(proposal.status)}</dd></div>
                  <div><dt>Review</dt><dd>{formatLabel(proposal.review_status)}</dd></div>
                  <div><dt>Sensitivity</dt><dd>{formatLabel(proposal.sensitivity)}</dd></div>
                  <div><dt>Retention</dt><dd>{formatLabel(proposal.retention)}</dd></div>
                  <div><dt>Sources</dt><dd>{proposal.source_ref_count}</dd></div>
                  <div><dt>Links</dt><dd>{proposal.link_ref_count}</dd></div>
                </dl>
              </details>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  {/if}
</section>

<style>
  .memory-panel { display: grid; grid-template-rows: auto minmax(0, 1fr); width: 100%; height: 100%; min-width: 0; min-height: 0; color: var(--poodle-color-text-primary); background: var(--poodle-color-background-canvas); }
  .memory-header { display: flex; align-items: center; justify-content: space-between; padding: 0.8rem 1rem; border-bottom: 1px solid var(--poodle-color-border-subtle); }
  h1, h2 { margin: 0; }
  h1 { font-size: 0.95rem; }
  h2 { font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.07em; }
  .memory-content { min-height: 0; overflow: auto; padding: 0.75rem; }
  .memory-group + .memory-group { margin-top: 1rem; }
  .group-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 0.25rem 0.45rem; color: var(--poodle-color-text-secondary); }
  .group-heading span { font-size: 0.72rem; }
  .record-list { display: grid; gap: 0.4rem; }
  .memory-record { min-width: 0; border: 1px solid var(--poodle-color-border-subtle); border-radius: var(--poodle-radius-control); background: var(--poodle-color-background-surface); }
  .memory-record[open] { border-color: var(--poodle-color-border-default); }
  .memory-record summary { display: grid; gap: 0.25rem; padding: 0.7rem 0.75rem; cursor: pointer; list-style-position: inside; }
  .memory-record summary::marker { color: var(--poodle-color-text-tertiary); }
  .record-id { min-width: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.76rem; font-weight: 600; }
  .record-meta { padding-left: 1rem; color: var(--poodle-color-text-secondary); font-size: 0.7rem; text-transform: capitalize; }
  .memory-record dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: 0.75rem; margin: 0; padding: 0.75rem; border-top: 1px solid var(--poodle-color-border-subtle); }
  .memory-record dl div { display: grid; gap: 0.18rem; min-width: 0; }
  dt { color: var(--poodle-color-text-secondary); font-size: 0.68rem; }
  dd { margin: 0; overflow-wrap: anywhere; font-size: 0.75rem; text-transform: capitalize; }
  .actor-refs { display: grid; gap: 0.25rem; padding: 0 0.75rem 0.75rem; }
  code { color: var(--poodle-color-text-tertiary); font-size: 0.66rem; overflow-wrap: anywhere; }
  .group-empty { padding: 1rem; text-align: center; border: 1px dashed var(--poodle-color-border-subtle); border-radius: var(--poodle-radius-control); }
  .panel-message { display: grid; place-content: center; justify-items: center; gap: 0.4rem; min-height: 100%; padding: 2rem; text-align: center; }
  .panel-error { color: var(--poodle-color-status-danger); }
</style>
