<script lang="ts">
  import { Button, IconButton, Text } from "@inflatable-cookie/poodle-svelte";
  import { refreshCw } from "../icons.generated";
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
    <Text size="sm" tone="muted">
      {memories.length} accepted · {proposals.length} proposed
    </Text>
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
    <div class="panel-message panel-error" role="alert">
      <span>{failure}</span>
      <Button variant="secondary" size="xs" onClick={() => loadMemory(projectId)}>Retry</Button>
    </div>
  {:else if !projectId}
    <div class="panel-message">
      <Text weight="semibold">No project selected</Text>
      <Text tone="muted">Select a project to inspect its shared memory.</Text>
    </div>
  {:else if loading}
    <div class="panel-message" role="status" aria-live="polite"><Text tone="muted">Loading memory…</Text></div>
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
              <article class:record-redacted={memory.display_redacted} class="memory-record">
                <div class="record-content">
                  <h3>{memory.display_title ?? (memory.display_redacted ? "Restricted memory" : "Untitled memory")}</h3>
                  {#if memory.display_summary}
                    <p>{memory.display_summary}</p>
                  {:else if memory.display_redacted}
                    <p class="redaction-note">Content is unavailable at this sensitivity.</p>
                  {/if}
                  <div class="record-meta">
                    <span>{formatLabel(memory.kind)}</span>
                    <span>{formatLabel(memory.scope)}</span>
                    {#if memory.display_truncated}<span>truncated</span>{/if}
                  </div>
                </div>
                <details class="record-details">
                  <summary>Details</summary>
                  <dl>
                    <div><dt>ID</dt><dd class="technical-value">{memory.memory_id}</dd></div>
                    <div><dt>Status</dt><dd>{formatLabel(memory.status)}</dd></div>
                    <div><dt>Confidence</dt><dd>{formatLabel(memory.confidence)}</dd></div>
                    <div><dt>Sensitivity</dt><dd>{formatLabel(memory.sensitivity)}</dd></div>
                    <div><dt>Retention</dt><dd>{formatLabel(memory.retention)}</dd></div>
                    <div><dt>Sources</dt><dd>{memory.source_ref_count}</dd></div>
                    <div><dt>Links</dt><dd>{memory.link_ref_count}</dd></div>
                    <div><dt>Evidence</dt><dd>{memory.evidence_ref_count}</dd></div>
                    <div><dt>Supersedes</dt><dd>{memory.supersedes_count}</dd></div>
                    <div><dt>Superseded by</dt><dd>{memory.superseded_by_count}</dd></div>
                  </dl>
                  <div class="actor-refs">
                    <code>created by {memory.created_by_ref}</code>
                    <code>accepted by {memory.accepted_by_ref}</code>
                    <code>reviewed by {memory.reviewer_ref}</code>
                  </div>
                </details>
              </article>
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
              <article class:record-redacted={proposal.display_redacted} class="memory-record proposal-record">
                <div class="record-content">
                  <h3>{proposal.display_title ?? (proposal.display_redacted ? "Restricted proposal" : "Untitled proposal")}</h3>
                  {#if proposal.display_summary}
                    <p>{proposal.display_summary}</p>
                  {:else if proposal.display_redacted}
                    <p class="redaction-note">Content is unavailable at this sensitivity.</p>
                  {/if}
                  <div class="record-meta">
                    <span>{formatLabel(proposal.kind)}</span>
                    <span>{formatLabel(proposal.scope)}</span>
                    <span>{formatLabel(proposal.review_status)}</span>
                    {#if proposal.display_truncated}<span>truncated</span>{/if}
                  </div>
                </div>
                <details class="record-details">
                  <summary>Details</summary>
                  <dl>
                    <div><dt>ID</dt><dd class="technical-value">{proposal.proposal_id}</dd></div>
                    <div><dt>Status</dt><dd>{formatLabel(proposal.status)}</dd></div>
                    <div><dt>Review</dt><dd>{formatLabel(proposal.review_status)}</dd></div>
                    <div><dt>Sensitivity</dt><dd>{formatLabel(proposal.sensitivity)}</dd></div>
                    <div><dt>Retention</dt><dd>{formatLabel(proposal.retention)}</dd></div>
                    <div><dt>Sources</dt><dd>{proposal.source_ref_count}</dd></div>
                    <div><dt>Links</dt><dd>{proposal.link_ref_count}</dd></div>
                    <div><dt>Supersedes</dt><dd>{proposal.supersedes_count}</dd></div>
                    <div><dt>Superseded by</dt><dd>{proposal.superseded_by_count}</dd></div>
                  </dl>
                </details>
              </article>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  {/if}
</section>

<style>
  .memory-panel { display: grid; grid-template-rows: auto minmax(0, 1fr); width: 100%; height: 100%; min-width: 0; min-height: 0; color: var(--poodle-color-text-primary); background: var(--poodle-color-background-canvas); }
  .memory-header { display: flex; align-items: center; justify-content: space-between; min-height: 2.5rem; padding: 0.35rem 0.75rem; border-bottom: 1px solid var(--poodle-color-border-subtle); }
  h2, h3, p { margin: 0; }
  h2 { font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.07em; }
  .memory-content { min-height: 0; overflow: auto; padding: 0.75rem; }
  .memory-group + .memory-group { margin-top: 1rem; }
  .group-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 0.25rem 0.45rem; color: var(--poodle-color-text-secondary); }
  .group-heading span { font-size: 0.72rem; }
  .record-list { display: grid; }
  .memory-record { min-width: 0; padding: 0.75rem 0.25rem; border-top: 1px solid var(--poodle-color-border-subtle); }
  .memory-record:first-child { border-top: 0; }
  .record-content { display: grid; gap: 0.35rem; padding: 0 0.25rem; }
  .record-content h3 { overflow-wrap: anywhere; font-size: 0.84rem; font-weight: 600; }
  .record-content p { color: var(--poodle-color-text-secondary); font-size: 0.76rem; line-height: 1.45; }
  .record-redacted .record-content h3, .redaction-note { color: var(--poodle-color-text-tertiary); }
  .record-meta { display: flex; flex-wrap: wrap; gap: 0.3rem; color: var(--poodle-color-text-tertiary); font-size: 0.68rem; text-transform: capitalize; }
  .record-meta span + span::before { margin-right: 0.3rem; content: "·"; }
  .record-details { margin-top: 0.45rem; }
  .record-details summary { width: fit-content; padding: 0.15rem 0.25rem; color: var(--poodle-color-text-secondary); cursor: pointer; font-size: 0.7rem; }
  .record-details summary::marker { color: var(--poodle-color-text-tertiary); }
  .memory-record dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: 0.7rem; margin: 0.35rem 0 0; padding: 0.7rem 0.25rem 0; border-top: 1px solid var(--poodle-color-border-subtle); }
  .memory-record dl div { display: grid; gap: 0.18rem; min-width: 0; }
  dt { color: var(--poodle-color-text-secondary); font-size: 0.68rem; }
  dd { margin: 0; overflow-wrap: anywhere; font-size: 0.75rem; text-transform: capitalize; }
  .technical-value { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; text-transform: none; }
  .actor-refs { display: grid; gap: 0.25rem; padding: 0.65rem 0.25rem 0; }
  code { color: var(--poodle-color-text-tertiary); font-size: 0.66rem; overflow-wrap: anywhere; }
  .group-empty { padding: 1rem; text-align: center; border: 1px dashed var(--poodle-color-border-subtle); border-radius: var(--poodle-radius-control); }
  .panel-message { display: grid; place-content: center; justify-items: center; gap: 0.4rem; min-height: 100%; padding: 2rem; text-align: center; }
  .panel-error { color: var(--poodle-color-status-danger); }
</style>
