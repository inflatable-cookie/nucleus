<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    queryCommandHistory,
    type CommandHistoryQueryResult,
    type ControlCommandEvidenceRecordDto,
  } from "./control";

  let loading = $state(false);
  let result = $state<CommandHistoryQueryResult | null>(null);
  let failure = $state<string | null>(null);
  let selectedEvidenceId = $state<string | null>(null);

  const records = $derived(result?.state === "records" ? result.records : []);
  const selectedRecord = $derived(
    records.find((record) => record.evidence_id === selectedEvidenceId) ?? records[0] ?? null,
  );
  const statusLabel = $derived(
    loading
      ? "loading"
      : failure
        ? "error"
        : result?.state === "records"
          ? `${records.length} run${records.length === 1 ? "" : "s"}`
          : (result?.state ?? "idle"),
  );
  const statusTone = $derived(loading ? "pending" : failure ? "danger" : "info");

  $effect(() => {
    if (selectedEvidenceId && !records.some((record) => record.evidence_id === selectedEvidenceId)) {
      selectedEvidenceId = null;
    }
  });

  async function loadCommandHistory() {
    loading = true;
    failure = null;

    try {
      result = await queryCommandHistory();
    } catch (error) {
      result = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function artifactPresence(record: ControlCommandEvidenceRecordDto) {
    if (record.stdout_artifact_ref && record.stderr_artifact_ref) {
      return "stdout, stderr";
    }
    if (record.stdout_artifact_ref) {
      return "stdout";
    }
    if (record.stderr_artifact_ref) {
      return "stderr";
    }
    return "none";
  }

  $effect(() => {
    void loadCommandHistory();
  });
</script>

<Surface>
  <section class="command-diagnostics-panel" aria-label="Command Diagnostics">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Command diagnostics</h2>
        <Text tone="muted">Read-only command history DTOs.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if failure}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{failure}</Text>
      </div>
    {:else if loading}
      <div class="panel-message">
        <Text tone="muted">Loading command history.</Text>
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
        <Text tone="muted">No command evidence available.</Text>
      </div>
    {:else}
      <div class="command-history-layout">
        <div class="command-history-list">
          {#each records as record}
            <button
              class:selected={record.evidence_id === selectedRecord?.evidence_id}
              type="button"
              onclick={() => (selectedEvidenceId = record.evidence_id)}
            >
              <span>{record.status}</span>
              <small>{record.command_request_id}</small>
              <small>{record.summary ?? "No summary."}</small>
            </button>
          {/each}
        </div>

        {#if selectedRecord}
          <dl class="command-history-detail">
            <div>
              <dt>Evidence</dt>
              <dd>{selectedRecord.evidence_id}</dd>
            </div>
            <div>
              <dt>Request</dt>
              <dd>{selectedRecord.command_request_id}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{selectedRecord.status}</dd>
            </div>
            <div>
              <dt>Exit</dt>
              <dd>{selectedRecord.exit_status ?? "none"}</dd>
            </div>
            <div>
              <dt>Retention</dt>
              <dd>{selectedRecord.retention}</dd>
            </div>
            <div>
              <dt>Artifacts</dt>
              <dd>{artifactPresence(selectedRecord)}</dd>
            </div>
            <div>
              <dt>Stdout ref</dt>
              <dd>{selectedRecord.stdout_artifact_ref ?? "none"}</dd>
            </div>
            <div>
              <dt>Stderr ref</dt>
              <dd>{selectedRecord.stderr_artifact_ref ?? "none"}</dd>
            </div>
            <div>
              <dt>Raw output</dt>
              <dd>not_retained</dd>
            </div>
            <div>
              <dt>Summary</dt>
              <dd>{selectedRecord.summary ?? "none"}</dd>
            </div>
          </dl>
        {/if}
      </div>
    {/if}

    <div class="panel-actions">
      <Text tone="muted">No execution controls.</Text>
      <Button
        variant="secondary"
        leadingIcon={refreshCw}
        onClick={loadCommandHistory}
        disabled={loading}
      >
        Refresh
      </Button>
    </div>
  </section>
</Surface>

<style>
  .command-diagnostics-panel {
    display: grid;
    align-content: start;
    gap: var(--poodle-space-stack-md);
    min-width: 0;
  }

  .command-history-layout {
    display: grid;
    gap: var(--poodle-space-stack-sm);
    min-width: 0;
  }

  .command-history-list {
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }

  .command-history-list button {
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

  .command-history-list button:hover,
  .command-history-list button.selected {
    border-color: var(--poodle-color-border-default);
    background: var(--poodle-color-background-surface);
  }

  .command-history-list span,
  .command-history-list small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-history-list span {
    font-size: 0.82rem;
    font-weight: 600;
  }

  .command-history-list small {
    color: var(--poodle-color-text-secondary);
    font-size: 0.74rem;
  }

  .command-history-detail {
    display: grid;
    gap: 1px;
    margin: 0;
    overflow: hidden;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-border-subtle);
  }

  .command-history-detail div {
    min-width: 0;
    padding: 0.65rem 0.75rem;
    background: var(--poodle-color-background-canvas);
  }

  .command-history-detail dt {
    margin: 0 0 0.2rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.68rem;
    font-weight: 600;
  }

  .command-history-detail dd {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--poodle-color-text-primary);
    font-family: var(--poodle-typography-code-family);
    font-size: 0.74rem;
    line-height: 1.35;
  }
</style>
