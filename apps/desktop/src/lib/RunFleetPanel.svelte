<script lang="ts">
  import { Button, IconButton, Text } from "@inflatable-cookie/poodle-svelte";
  import { refreshCw } from "../icons.generated";
  import { onMount } from "svelte";
  import {
    queryOrchestrationRuns,
    type OrchestrationRunsQueryResult,
  } from "./control/runFleet";
  import type { ControlOrchestrationRunSummaryDto } from "./control/generated/ControlOrchestrationRunSummaryDto";

  type FleetGroup = "active" | "delivered" | "terminal";
  type GroupDefinition = { key: FleetGroup; label: string; states: string[] };

  let {
    selectedProjectId,
    onOpenRun,
  }: {
    selectedProjectId: string | null;
    onOpenRun: (run: ControlOrchestrationRunSummaryDto) => void;
  } = $props();

  let runs = $state<ControlOrchestrationRunSummaryDto[]>([]);
  let stateCounts = $state<{ state: string; count: number }[]>([]);
  let loading = $state(false);
  let failure = $state<string | null>(null);
  let loadedProjectId = $state<string | null>(null);
  let loadVersion = 0;

  const groupDefinitions: GroupDefinition[] = [
    { key: "active", label: "Active", states: ["proposed", "dispatched", "running"] },
    { key: "delivered", label: "Delivered", states: ["delivered"] },
    { key: "terminal", label: "Terminal", states: ["accepted", "rejected", "failed", "cancelled"] },
  ];

  const groupedRuns = $derived(
    groupDefinitions.map((group) => ({
      ...group,
      runs: runs.filter((run) => group.states.includes(run.state)),
    })),
  );

  $effect(() => {
    const projectId = selectedProjectId;
    loadedProjectId = null;
    runs = [];
    stateCounts = [];
    failure = null;
    if (projectId) void loadRuns(projectId);
  });

  onMount(() => {
    const refresh = () => {
      if (selectedProjectId) void loadRuns(selectedProjectId);
    };
    window.addEventListener("nucleus:runs-changed", refresh);
    window.addEventListener("nucleus:threads-changed", refresh);
    return () => {
      window.removeEventListener("nucleus:runs-changed", refresh);
      window.removeEventListener("nucleus:threads-changed", refresh);
    };
  });

  async function loadRuns(projectId: string): Promise<void> {
    const version = ++loadVersion;
    loading = true;
    failure = null;
    try {
      const result = await queryOrchestrationRuns(projectId);
      if (version !== loadVersion || projectId !== selectedProjectId) return;
      applyResult(result, projectId);
    } catch (caught) {
      if (version === loadVersion && projectId === selectedProjectId) {
        failure = formatError(caught);
      }
    } finally {
      if (version === loadVersion) loading = false;
    }
  }

  function applyResult(result: OrchestrationRunsQueryResult, projectId: string): void {
    loadedProjectId = projectId;
    if (result.state === "record") {
      runs = result.runs;
      stateCounts = result.state_counts;
      return;
    }
    if (result.state === "empty") {
      runs = [];
      stateCounts = [];
      return;
    }
    failure = result.state === "unexpected"
      ? result.reason
      : result.state === "unsupported" || result.state === "error"
        ? result.reason
        : "Fleet data is unavailable.";
  }

  function groupCount(group: GroupDefinition): number {
    return runs.filter((run) => group.states.includes(run.state)).length;
  }

  function stateCount(state: string): number {
    return stateCounts.find((entry) => entry.state === state)?.count ?? 0;
  }

  function runLabel(runId: string): string {
    return runId.startsWith("run:") ? runId.slice(4) : runId;
  }

  function displayState(state: string): string {
    return state.replaceAll("_", " ");
  }

  function relativeTime(updatedAt: bigint): string {
    const raw = Number(updatedAt);
    if (!Number.isFinite(raw)) return "recency unavailable";
    const milliseconds = raw > 1_000_000_000_000 ? raw : raw * 1000;
    const seconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function formatError(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }
</script>

<section class="fleet-panel" aria-label="Run fleet">
  <header class="fleet-header">
    <div>
      <h1>Run fleet</h1>
      <Text size="sm" tone="muted">
        {loading ? "Loading" : `${runs.length} ${runs.length === 1 ? "run" : "runs"}`}
      </Text>
    </div>
    <IconButton
      variant="ghost"
      size="sm"
      icon={refreshCw}
      ariaLabel="Refresh run fleet"
      tooltip="Refresh run fleet"
      onClick={() => selectedProjectId && void loadRuns(selectedProjectId)}
      disabled={loading || !selectedProjectId}
    />
  </header>

  {#if stateCounts.length > 0}
    <div class="state-board" aria-label="Run state counts">
      {#each stateCounts as entry (entry.state)}
        <span class="state-count"><strong>{entry.count}</strong> {displayState(entry.state)}</span>
      {/each}
    </div>
  {/if}

  {#if !selectedProjectId}
    <div class="fleet-message"><Text tone="muted">Select a project to view its runs.</Text></div>
  {:else if failure}
    <div class="fleet-message fleet-error" role="alert">
      <Text tone="danger">{failure}</Text>
      <Button variant="secondary" size="xs" onClick={() => void loadRuns(selectedProjectId)}>Retry</Button>
    </div>
  {:else if loading && runs.length === 0}
    <div class="fleet-message" role="status" aria-live="polite"><Text tone="muted">Loading run fleet…</Text></div>
  {:else if runs.length === 0}
    <div class="fleet-message">
      <Text weight="semibold">No runs recorded</Text>
      <Text tone="muted">Dispatch a worker run to populate this fleet.</Text>
    </div>
  {:else}
    <div class="fleet-groups">
      {#each groupedRuns as group (group.key)}
        {#if group.runs.length > 0}
          <section class="fleet-group" aria-labelledby={`fleet-group-${group.key}`}>
            <header class="group-header">
              <h2 id={`fleet-group-${group.key}`}>{group.label}</h2>
              <span>{groupCount(group)}</span>
            </header>
            <div class="run-list">
              {#each group.runs as run (run.run_id)}
                <button
                  type="button"
                  class="run-row"
                  aria-label={`Open run ${runLabel(run.run_id)}`}
                  onclick={() => onOpenRun(run)}
                >
                  <span class="run-row-heading">
                    <span class="run-title">{runLabel(run.run_id)}</span>
                    <span class={`state-badge state-${run.state}`}>{displayState(run.state)}</span>
                  </span>
                  <span class="run-row-meta">
                    <span>{run.provider_instance} · {run.provider_model}</span>
                    <span>{relativeTime(run.updated_at)}</span>
                  </span>
                  <span class="run-row-meta run-row-subtle">
                    <span>Budget burn not reported</span>
                    <span>{run.has_closeout ? "Closeout recorded" : "No closeout"}</span>
                  </span>
                  {#if run.state === "failed"}
                    <span class="degraded-truth">Failure receipt recorded; open the worker thread for its reason.</span>
                  {/if}
                </button>
              {/each}
            </div>
          </section>
        {/if}
      {/each}
    </div>
  {/if}
</section>

<style>
  .fleet-panel { display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 0.75rem; height: 100%; min-height: 0; padding: 0.75rem; overflow: auto; }
  .fleet-header, .group-header, .run-row-heading, .run-row-meta { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; min-width: 0; }
  .fleet-header h1, .group-header h2 { margin: 0; color: var(--poodle-color-text-primary); }
  .fleet-header h1 { font-size: 0.95rem; }
  .group-header h2 { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; }
  .group-header > span, .state-count { color: var(--poodle-color-text-muted); font-size: 0.7rem; }
  .state-board { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .state-count { padding: 0.25rem 0.4rem; border: 1px solid var(--poodle-color-border-default); border-radius: var(--poodle-radius-control); }
  .state-count strong { color: var(--poodle-color-text-primary); }
  .fleet-groups { display: grid; align-content: start; gap: 1rem; }
  .fleet-group { display: grid; gap: 0.4rem; }
  .run-list { display: grid; gap: 0.4rem; }
  .run-row { display: grid; gap: 0.28rem; width: 100%; padding: 0.55rem; color: var(--poodle-color-text-secondary); text-align: left; border: 1px solid var(--poodle-color-border-default); border-radius: var(--poodle-radius-control); background: var(--poodle-color-background-surface); cursor: pointer; }
  .run-row:hover, .run-row:focus-visible { border-color: var(--poodle-color-border-focus); outline: none; }
  .run-title { overflow: hidden; color: var(--poodle-color-text-primary); font-size: 0.78rem; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .run-row-meta { color: var(--poodle-color-text-secondary); font-size: 0.68rem; }
  .run-row-meta > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-row-subtle { color: var(--poodle-color-text-muted); }
  .state-badge { flex: none; padding: 0.15rem 0.35rem; border-radius: 999px; color: var(--poodle-color-text-primary); font-size: 0.62rem; text-transform: capitalize; }
  .state-running, .state-dispatched, .state-proposed { background: color-mix(in srgb, var(--poodle-color-accent-default) 18%, transparent); }
  .state-delivered, .state-accepted { background: color-mix(in srgb, var(--poodle-color-success-default) 20%, transparent); }
  .state-failed, .state-rejected, .state-cancelled { background: color-mix(in srgb, var(--poodle-color-danger-default) 20%, transparent); }
  .degraded-truth { color: var(--poodle-color-danger-default); font-size: 0.66rem; }
  .fleet-message { display: grid; align-content: center; justify-items: start; gap: 0.5rem; min-height: 8rem; }
  .fleet-error { grid-template-columns: 1fr auto; align-items: center; }
</style>
