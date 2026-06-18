<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    queryDiagnostics,
    type ControlDiagnosticsSnapshotDto,
    type DiagnosticsQueryResult,
    type EffigyDiagnosticsDto,
    type ScmSessionDiagnosticsDto,
    type StewardDiagnosticsDto,
    type SyncDiagnosticsDto,
  } from "./control";

  let loading = $state(false);
  let result = $state<DiagnosticsQueryResult | null>(null);
  let failure = $state<string | null>(null);

  const snapshot = $derived(resultSnapshot(result));
  const liveRecordCount = $derived(
    snapshot
      ? stewardCount(snapshot.steward) +
          syncCount(snapshot.management_sync) +
          scmCount(snapshot.scm_session) +
          snapshot.effigy.selector_refs.length +
          snapshot.effigy.evidence_refs.length
      : 0,
  );
  const statusLabel = $derived(
    loading
      ? "loading"
      : failure
        ? "error"
        : result?.state === "records"
          ? "active"
          : (result?.state ?? "idle"),
  );
  const statusTone = $derived(
    loading
      ? "pending"
      : failure || result?.state === "error" || result?.state === "unexpected"
        ? "danger"
        : result?.state === "unsupported"
          ? "warning"
          : result?.state === "empty"
            ? "neutral"
            : "info",
  );

  async function loadDiagnostics() {
    loading = true;
    failure = null;

    try {
      result = await queryDiagnostics("all");
    } catch (error) {
      result = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function resultSnapshot(value: DiagnosticsQueryResult | null): ControlDiagnosticsSnapshotDto | null {
    if (value?.state !== "records") {
      return null;
    }
    if (value.result.domain !== "all") {
      return null;
    }
    return value.result.record;
  }

  function stewardCount(record: StewardDiagnosticsDto): number {
    return record.proposals.length + record.command_admissions.length + record.command_outcomes.length;
  }

  function syncCount(record: SyncDiagnosticsDto): number {
    return (
      record.plans.length +
      record.repairs.length +
      record.assistance_routes.length +
      record.capture_preps.length
    );
  }

  function scmCount(record: ScmSessionDiagnosticsDto): number {
    return record.sessions.length + record.admissions.length + record.work_item_links.length;
  }

  function effigyState(record: EffigyDiagnosticsDto): string {
    return record.health_status ?? record.validation_status ?? record.integration_status;
  }

  function sourceSummary(snapshot: ControlDiagnosticsSnapshotDto): string {
    return [
      snapshot.steward.source_summary,
      snapshot.effigy.source_summary,
      snapshot.management_sync.source_summary,
      snapshot.scm_session.source_summary,
    ]
      .filter(Boolean)
      .join(" / ");
  }

  $effect(() => {
    void loadDiagnostics();
  });
</script>

<Surface>
  <section class="diagnostics-proof-panel" aria-label="Agent Diagnostics Proof">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Agent diagnostics</h2>
        <Text tone="muted">Read-only steward, Effigy, sync, and SCM DTOs.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if failure}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{failure}</Text>
      </div>
    {:else if loading}
      <div class="panel-message">
        <Text tone="muted">Loading diagnostics.</Text>
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
    {:else if snapshot}
      <div class="diagnostics-proof-grid">
        <section>
          <h3>Steward</h3>
          <dl>
            <div>
              <dt>Source</dt>
              <dd>{snapshot.steward.source_status}</dd>
            </div>
            <div>
              <dt>Records</dt>
              <dd>{stewardCount(snapshot.steward)}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>Effigy</h3>
          <dl>
            <div>
              <dt>Source</dt>
              <dd>{snapshot.effigy.source_status}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{effigyState(snapshot.effigy)}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>Sync</h3>
          <dl>
            <div>
              <dt>Source</dt>
              <dd>{snapshot.management_sync.source_status}</dd>
            </div>
            <div>
              <dt>Records</dt>
              <dd>{syncCount(snapshot.management_sync)}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>SCM</h3>
          <dl>
            <div>
              <dt>Source</dt>
              <dd>{snapshot.scm_session.source_status}</dd>
            </div>
            <div>
              <dt>Records</dt>
              <dd>{scmCount(snapshot.scm_session)}</dd>
            </div>
          </dl>
        </section>
      </div>

      {#if liveRecordCount === 0}
        <div class="panel-message">
          <Text tone="muted">{sourceSummary(snapshot)}</Text>
        </div>
      {/if}
    {:else}
      <div class="panel-message">
        <Text tone="muted">No diagnostics response yet.</Text>
      </div>
    {/if}

    <div class="panel-actions">
      <Text tone="muted">No mutation controls.</Text>
      <Button
        variant="secondary"
        leadingIcon={refreshCw}
        onClick={loadDiagnostics}
        disabled={loading}
      >
        Refresh
      </Button>
    </div>
  </section>
</Surface>

<style>
  .diagnostics-proof-panel {
    display: grid;
    align-content: start;
    gap: var(--poodle-space-stack-md);
    min-width: 0;
  }

  .diagnostics-proof-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--poodle-space-stack-sm);
    min-width: 0;
  }

  .diagnostics-proof-grid section {
    display: grid;
    gap: 0.6rem;
    min-width: 0;
    padding: 0.75rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-background-canvas);
  }

  .diagnostics-proof-grid h3 {
    margin: 0;
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-size: 0.82rem;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diagnostics-proof-grid dl {
    display: grid;
    gap: 0.45rem;
    margin: 0;
  }

  .diagnostics-proof-grid div {
    min-width: 0;
  }

  .diagnostics-proof-grid dt {
    margin: 0 0 0.15rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.68rem;
    font-weight: 600;
  }

  .diagnostics-proof-grid dd {
    margin: 0;
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-family: var(--poodle-typography-code-family);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 760px) {
    .diagnostics-proof-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
