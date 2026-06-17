<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    queryRuntimeReadiness,
    type ControlRuntimeReadinessDiagnosticDto,
    type RuntimeReadinessQueryResult,
  } from "./control";

  let loading = $state(false);
  let result = $state<RuntimeReadinessQueryResult | null>(null);
  let failure = $state<string | null>(null);
  let selectedHostId = $state<string | null>(null);

  const records = $derived(result?.state === "records" ? result.records : []);
  const selectedRecord = $derived(
    records.find((record) => record.host_id === selectedHostId) ?? records[0] ?? null,
  );
  const statusLabel = $derived(
    loading
      ? "loading"
      : failure
        ? "error"
        : result?.state === "records"
          ? `${records.length} host${records.length === 1 ? "" : "s"}`
          : (result?.state ?? "idle"),
  );
  const statusTone = $derived(
    loading
      ? "pending"
      : failure
        ? "danger"
        : selectedRecord?.status === "ready"
          ? "success"
          : selectedRecord?.status === "unsupported"
            ? "warning"
            : "info",
  );

  $effect(() => {
    if (selectedHostId && !records.some((record) => record.host_id === selectedHostId)) {
      selectedHostId = null;
    }
  });

  async function loadRuntimeReadiness() {
    loading = true;
    failure = null;

    try {
      result = await queryRuntimeReadiness();
    } catch (error) {
      result = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function blockerSummary(record: ControlRuntimeReadinessDiagnosticDto) {
    if (record.blockers.length === 0) {
      return "none";
    }
    return record.blockers.map((blocker) => blocker.code).join(", ");
  }

  $effect(() => {
    void loadRuntimeReadiness();
  });
</script>

<Surface>
  <section class="runtime-readiness-panel" aria-label="Runtime Readiness">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Runtime readiness</h2>
        <Text tone="muted">Read-only host diagnostics.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if failure}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{failure}</Text>
      </div>
    {:else if loading}
      <div class="panel-message">
        <Text tone="muted">Loading runtime readiness.</Text>
      </div>
    {:else if result?.state === "unsupported"}
      <div class="panel-message">
        <Text tone="muted">{result.reason}</Text>
      </div>
    {:else if result?.state === "error"}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{result.kind}: {result.reason}</Text>
      </div>
    {:else if result?.state === "unexpected"}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{result.reason}</Text>
      </div>
    {:else if records.length === 0}
      <div class="panel-message">
        <Text tone="muted">No runtime readiness records available.</Text>
      </div>
    {:else}
      <div class="runtime-readiness-layout">
        <div class="runtime-readiness-list">
          {#each records as record}
            <button
              class:selected={record.host_id === selectedRecord?.host_id}
              type="button"
              onclick={() => (selectedHostId = record.host_id)}
            >
              <span>{record.host_id}</span>
              <small>{record.runtime_surface}</small>
              <small>{record.status}: {blockerSummary(record)}</small>
            </button>
          {/each}
        </div>

        {#if selectedRecord}
          <dl class="runtime-readiness-detail">
            <div>
              <dt>Host</dt>
              <dd>{selectedRecord.host_id}</dd>
            </div>
            <div>
              <dt>Surface</dt>
              <dd>{selectedRecord.runtime_surface}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{selectedRecord.status}</dd>
            </div>
            <div>
              <dt>Summary</dt>
              <dd>{selectedRecord.summary ?? "none"}</dd>
            </div>
          </dl>

          <div class="runtime-readiness-section">
            <h3>Blockers</h3>
            {#if selectedRecord.blockers.length === 0}
              <Text tone="muted">None.</Text>
            {:else}
              <ul>
                {#each selectedRecord.blockers as blocker}
                  <li>
                    <strong>{blocker.code}</strong>
                    <span>{blocker.source}</span>
                    <p>{blocker.message}</p>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <div class="runtime-readiness-section">
            <h3>Evidence refs</h3>
            {#if selectedRecord.evidence_refs.length === 0}
              <Text tone="muted">None.</Text>
            {:else}
              <ul>
                {#each selectedRecord.evidence_refs as evidenceRef}
                  <li><code>{evidenceRef}</code></li>
                {/each}
              </ul>
            {/if}
          </div>

          <div class="runtime-readiness-section">
            <h3>Hints</h3>
            {#if selectedRecord.repair_hints.length === 0}
              <Text tone="muted">None.</Text>
            {:else}
              <ul>
                {#each selectedRecord.repair_hints as hint}
                  <li>{hint}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <div class="panel-actions">
      <Text tone="muted">Read-only diagnostics.</Text>
      <Button
        variant="secondary"
        leadingIcon={refreshCw}
        onClick={loadRuntimeReadiness}
        disabled={loading}
      >
        Refresh
      </Button>
    </div>
  </section>
</Surface>

<style>
  .runtime-readiness-panel {
    display: grid;
    align-content: start;
    gap: var(--poodle-space-stack-md);
    min-width: 0;
  }

  .runtime-readiness-layout {
    display: grid;
    gap: var(--poodle-space-stack-sm);
    min-width: 0;
  }

  .runtime-readiness-list {
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }

  .runtime-readiness-list button {
    display: grid;
    gap: 0.2rem;
    width: 100%;
    min-width: 0;
    padding: 0.7rem 0.75rem;
    color: var(--poodle-color-text-primary);
    text-align: left;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-canvas);
  }

  .runtime-readiness-list button:hover,
  .runtime-readiness-list button.selected {
    border-color: var(--poodle-color-border-default);
    background: var(--poodle-color-background-surface);
  }

  .runtime-readiness-list span,
  .runtime-readiness-list small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .runtime-readiness-list span {
    font-size: 0.82rem;
    font-weight: 600;
  }

  .runtime-readiness-list small {
    color: var(--poodle-color-text-secondary);
    font-size: 0.74rem;
  }

  .runtime-readiness-detail {
    display: grid;
    gap: 1px;
    margin: 0;
    overflow: hidden;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-border-subtle);
  }

  .runtime-readiness-detail div {
    min-width: 0;
    padding: 0.65rem 0.75rem;
    background: var(--poodle-color-background-canvas);
  }

  .runtime-readiness-detail dt {
    margin: 0 0 0.2rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.68rem;
    font-weight: 600;
  }

  .runtime-readiness-detail dd {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--poodle-color-text-primary);
    font-family: var(--poodle-typography-code-family);
    font-size: 0.74rem;
    line-height: 1.35;
  }

  .runtime-readiness-section {
    display: grid;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.75rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-background-canvas);
  }

  .runtime-readiness-section h3 {
    margin: 0;
    color: var(--poodle-color-text-primary);
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.3;
  }

  .runtime-readiness-section ul {
    display: grid;
    gap: 0.45rem;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .runtime-readiness-section li {
    display: grid;
    gap: 0.18rem;
    min-width: 0;
    color: var(--poodle-color-text-primary);
    font-size: 0.75rem;
    line-height: 1.35;
  }

  .runtime-readiness-section strong,
  .runtime-readiness-section code {
    overflow-wrap: anywhere;
    font-family: var(--poodle-typography-code-family);
    font-size: 0.74rem;
  }

  .runtime-readiness-section span {
    overflow-wrap: anywhere;
    color: var(--poodle-color-text-secondary);
    font-size: 0.72rem;
  }

  .runtime-readiness-section p {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--poodle-color-text-secondary);
  }
</style>
