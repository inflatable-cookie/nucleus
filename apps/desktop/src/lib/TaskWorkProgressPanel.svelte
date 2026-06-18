<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    queryTaskWorkProgress,
    type TaskAgentWorkUnitDiagnosticDto,
    type TaskWorkProgressQueryResult,
  } from "./control";

  let loading = $state(false);
  let result = $state<TaskWorkProgressQueryResult | null>(null);
  let failure = $state<string | null>(null);
  let selectedWorkItemId = $state<string | null>(null);

  const records = $derived(result?.state === "records" ? result.records : []);
  const selectedRecord = $derived(
    records.find((record) => record.work_item_id === selectedWorkItemId) ?? records[0] ?? null,
  );
  const statusLabel = $derived(
    loading
      ? "loading"
      : failure
        ? "error"
        : result?.state === "records"
          ? `${records.length} unit${records.length === 1 ? "" : "s"}`
          : (result?.state ?? "idle"),
  );
  const statusTone = $derived(
    loading
      ? "pending"
      : failure || result?.state === "error" || result?.state === "unexpected"
        ? "danger"
        : result?.state === "unsupported"
          ? "warning"
          : "info",
  );

  $effect(() => {
    if (selectedWorkItemId && !records.some((record) => record.work_item_id === selectedWorkItemId)) {
      selectedWorkItemId = null;
    }
  });

  async function loadProgress() {
    loading = true;
    failure = null;

    try {
      result = await queryTaskWorkProgress();
    } catch (error) {
      result = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function runtimeTone(record: TaskAgentWorkUnitDiagnosticDto): string {
    if (record.runtime.startsWith("waiting")) {
      return "waiting";
    }
    if (record.runtime === "failed" || record.runtime === "recovery_required") {
      return "blocked";
    }
    if (record.runtime === "completed") {
      return "complete";
    }
    return "active";
  }

  function reviewTone(record: TaskAgentWorkUnitDiagnosticDto): string {
    if (record.review === "awaiting_review") {
      return "review";
    }
    if (record.review === "needs_changes" || record.review === "rejected") {
      return "blocked";
    }
    if (record.review === "accepted") {
      return "complete";
    }
    return "neutral";
  }

  function refsSummary(record: TaskAgentWorkUnitDiagnosticDto): string {
    return [
      `${record.receipt_ids.length} receipts`,
      `${record.checkpoint_ids.length} checkpoints`,
      `${record.diff_summary_ids.length} diffs`,
    ].join(" / ");
  }

  function joinedRefs(refs: string[]): string {
    return refs.length > 0 ? refs.join(", ") : "none";
  }

  $effect(() => {
    void loadProgress();
  });
</script>

<Surface>
  <section class="task-work-progress-panel" aria-label="Task Work Progress">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Task work progress</h2>
        <Text tone="muted">Read-only task-agent work units.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if failure}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{failure}</Text>
      </div>
    {:else if loading}
      <div class="panel-message">
        <Text tone="muted">Loading task work progress.</Text>
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
        <Text tone="muted">No task work progress available.</Text>
      </div>
    {:else}
      <div class="task-work-layout">
        <div class="task-work-list">
          {#each records as record}
            <button
              class:selected={record.work_item_id === selectedRecord?.work_item_id}
              type="button"
              onclick={() => (selectedWorkItemId = record.work_item_id)}
            >
              <span>{record.work_item_id}</span>
              <small>{record.runtime} / {record.review}</small>
              <small>{refsSummary(record)}</small>
            </button>
          {/each}
        </div>

        {#if selectedRecord}
          <div class="task-work-detail">
            <div class="state-row">
              <span class={`state-pill ${runtimeTone(selectedRecord)}`}>
                {selectedRecord.runtime}
              </span>
              <span class={`state-pill ${reviewTone(selectedRecord)}`}>
                {selectedRecord.review}
              </span>
            </div>

            <dl>
              <div>
                <dt>Task</dt>
                <dd>{selectedRecord.task_id}</dd>
              </div>
              <div>
                <dt>Project</dt>
                <dd>{selectedRecord.project_id}</dd>
              </div>
              <div>
                <dt>Session</dt>
                <dd>{selectedRecord.session_id ?? "none"}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{selectedRecord.last_source_id}</dd>
              </div>
              <div>
                <dt>Receipts</dt>
                <dd>{joinedRefs(selectedRecord.receipt_ids)}</dd>
              </div>
              <div>
                <dt>Checkpoints</dt>
                <dd>{joinedRefs(selectedRecord.checkpoint_ids)}</dd>
              </div>
              <div>
                <dt>Diff summaries</dt>
                <dd>{joinedRefs(selectedRecord.diff_summary_ids)}</dd>
              </div>
              <div>
                <dt>Validation</dt>
                <dd>{joinedRefs(selectedRecord.validation_refs)}</dd>
              </div>
              <div>
                <dt>Artifacts</dt>
                <dd>{joinedRefs(selectedRecord.artifact_refs)}</dd>
              </div>
              <div>
                <dt>Issues</dt>
                <dd>
                  {selectedRecord.issues.length === 0
                    ? "none"
                    : selectedRecord.issues.map((issue) => issue.code).join(", ")}
                </dd>
              </div>
              <div>
                <dt>Summary</dt>
                <dd>{selectedRecord.summary}</dd>
              </div>
            </dl>
          </div>
        {/if}
      </div>
    {/if}

    <div class="panel-actions">
      <Text tone="muted">No approval, resume, or review controls.</Text>
      <Button variant="secondary" leadingIcon={refreshCw} onClick={loadProgress} disabled={loading}>
        Refresh
      </Button>
    </div>
  </section>
</Surface>

<style>
  .task-work-progress-panel {
    display: grid;
    align-content: start;
    gap: var(--poodle-space-stack-md);
    min-width: 0;
  }

  .task-work-layout,
  .task-work-list {
    display: grid;
    gap: var(--poodle-space-stack-sm);
    min-width: 0;
  }

  .task-work-list button {
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

  .task-work-list button:hover,
  .task-work-list button.selected {
    border-color: var(--poodle-color-border-default);
    background: var(--poodle-color-background-surface);
  }

  .task-work-list span,
  .task-work-list small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-work-list span {
    font-size: 0.82rem;
    font-weight: 600;
  }

  .task-work-list small {
    color: var(--poodle-color-text-secondary);
    font-size: 0.74rem;
  }

  .task-work-detail {
    display: grid;
    gap: var(--poodle-space-stack-sm);
    min-width: 0;
  }

  .state-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .state-pill {
    max-width: 100%;
    padding: 0.25rem 0.45rem;
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-size: 0.72rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-canvas);
  }

  .state-pill.waiting,
  .state-pill.review {
    border-color: var(--poodle-color-status-warning);
  }

  .state-pill.blocked {
    border-color: var(--poodle-color-status-danger);
  }

  .state-pill.complete {
    border-color: var(--poodle-color-status-success);
  }

  .task-work-detail dl {
    display: grid;
    gap: 1px;
    margin: 0;
    overflow: hidden;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-border-subtle);
  }

  .task-work-detail dl div {
    min-width: 0;
    padding: 0.65rem 0.75rem;
    background: var(--poodle-color-background-canvas);
  }

  .task-work-detail dt {
    margin: 0 0 0.2rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.68rem;
    font-weight: 600;
  }

  .task-work-detail dd {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--poodle-color-text-primary);
    font-family: var(--poodle-typography-code-family);
    font-size: 0.74rem;
    line-height: 1.35;
  }
</style>
