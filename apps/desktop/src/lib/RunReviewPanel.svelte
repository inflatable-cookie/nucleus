<script lang="ts">
  import { Button, Text } from "@inflatable-cookie/poodle-svelte";
  import {
    queryOrchestrationRunReview,
    queryOrchestrationRunReviewPatch,
    submitRunTransition,
    type OrchestrationRunReviewQueryResult,
  } from "./control/runFleet";
  import type { ControlOrchestrationRunReviewDto } from "./control/generated/ControlOrchestrationRunReviewDto";
  import { unifiedDiffLineKind } from "./diffSupport";

  let {
    projectId,
    runId,
    onOpenThread,
    onPrepareRework,
    onReviewed,
  }: {
    projectId: string | null;
    runId: string | null;
    onOpenThread: () => void;
    onPrepareRework: () => void;
    onReviewed: () => void;
  } = $props();

  let review = $state<ControlOrchestrationRunReviewDto | null>(null);
  let loading = $state(false);
  let failure = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let transitioning = $state(false);
  let selectedPath = $state<string | null>(null);
  let patch = $state<{ text: string | null; additions: bigint; deletions: bigint; unavailable: string | null } | null>(null);
  let patchLoading = $state(false);
  let loadedKey = $state("");

  const patchLines = $derived(patch?.text?.split("\n") ?? []);

  $effect(() => {
    const target = `${projectId ?? ""}:${runId ?? ""}`;
    if (target === loadedKey) return;
    void loadReview();
  });

  async function loadReview(): Promise<void> {
    review = null;
    failure = null;
    notice = null;
    patch = null;
    selectedPath = null;
    if (!projectId || !runId) return;
    loadedKey = `${projectId}:${runId}`;

    loading = true;
    try {
      const result = await queryOrchestrationRunReview(projectId, runId);
      if (result.state !== "record") {
        failure = fallbackMessage(result);
        return;
      }
      review = result.review;
      const firstFile = result.review.diff.files[0] ?? null;
      if (firstFile) await loadPatch(firstFile.path);
    } catch (caught) {
      failure = formatError(caught);
    } finally {
      loading = false;
    }
  }

  async function loadPatch(path: string): Promise<void> {
    if (!projectId || !runId) return;
    selectedPath = path;
    patch = null;
    patchLoading = true;
    try {
      const result = await queryOrchestrationRunReviewPatch(projectId, runId, path);
      if (result.state !== "record") {
        patch = {
          text: null,
          additions: 0n,
          deletions: 0n,
          unavailable: fallbackMessage(result),
        };
        return;
      }
      patch = {
        text: result.patch.patch,
        additions: result.patch.additions,
        deletions: result.patch.deletions,
        unavailable: result.patch.available
          ? null
          : result.patch.unreachable_reason ?? "Diff is unavailable.",
      };
    } catch (caught) {
      patch = { text: null, additions: 0n, deletions: 0n, unavailable: formatError(caught) };
    } finally {
      patchLoading = false;
    }
  }

  async function applyDisposition(action: "accept" | "reject"): Promise<void> {
    if (!runId || transitioning) return;
    transitioning = true;
    failure = null;
    notice = null;
    try {
      const reason = action === "reject" ? "Rejected by operator review." : null;
      const result = await submitRunTransition(runId, action, null, reason);
      if (result.state !== "accepted") {
        failure = result.state === "rejected" ? result.reason : result.reason;
        return;
      }
      notice = action === "accept" ? "Run accepted." : "Run rejected.";
      onReviewed();
      await loadReview();
    } catch (caught) {
      failure = formatError(caught);
    } finally {
      transitioning = false;
    }
  }

  function fallbackMessage(result: { state: string; reason?: string; kind?: string }): string {
    return result.reason ?? `Run review ${result.state}.`;
  }

  function formatError(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  function runLabel(runId: string): string {
    return runId.startsWith("run:") ? runId.slice(4) : runId;
  }

  function displayState(state: string): string {
    return state.replaceAll("_", " ");
  }

  function validationLabel(status: string | null): string {
    if (!status) return "Validation not recorded";
    if (status === "passed") return "Validation passed";
    if (status === "failed") return "Validation failed";
    if (status === "unavailable") return "Validation unavailable";
    return `Validation: ${status}`;
  }

  function relativeTime(at: bigint): string {
    const raw = Number(at);
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
</script>

<section class="run-review-panel" aria-label={`Run review ${runId ? runLabel(runId) : ""}`}>
  {#if !runId}
    <div class="empty"><Text tone="muted">Select a delivered run to review its closeout and diff.</Text></div>
  {:else if loading && !review}
    <div class="empty" role="status" aria-live="polite"><Text tone="muted">Loading run review…</Text></div>
  {:else if failure && !review}
    <div class="empty" role="alert"><Text tone="danger">{failure}</Text></div>
  {:else if review}
    <header class="review-header">
      <div class="review-heading">
        <strong>{runLabel(review.run_id)}</strong>
        <span class={`state-badge state-${review.state}`}>{displayState(review.state)}</span>
      </div>
      <div class="review-meta">
        <span>{review.provider_instance} · {review.provider_model}</span>
        <span>Updated {relativeTime(review.updated_at)}</span>
      </div>
    </header>

    {#if review.closeout}
      <section class="review-section" aria-label="Closeout">
        <h2>Closeout</h2>
        <p class="closeout-summary">{review.closeout.summary}</p>
        <div class="evidence-board">
          <span class="validation-badge validation-{review.validation.status ?? "missing"}">
            {validationLabel(review.validation.status)}
          </span>
          {#if review.validation.changed_files !== null}
            <span class="evidence-chip">{review.validation.changed_files} changed files</span>
          {/if}
          {#if review.validation.commit_created !== null}
            <span class="evidence-chip">
              {review.validation.commit_created ? "Committed" : "Commit failed"}
            </span>
          {/if}
          {#if review.validation.push_executed !== null}
            <span class="evidence-chip">
              {review.validation.push_executed ? "Pushed" : "Not pushed"}
            </span>
          {/if}
        </div>
        {#if review.closeout.evidence_refs.length > 0}
          <details class="evidence-details">
            <summary>Evidence refs ({review.closeout.evidence_refs.length})</summary>
            <ul>
              {#each review.closeout.evidence_refs as evidence (evidence)}
                <li><code>{evidence}</code></li>
              {/each}
            </ul>
          </details>
        {/if}
      </section>
    {/if}

    <section class="review-section" aria-label="Diff against base">
      <h2>Diff against base</h2>
      {#if review.diff.available}
        <div class="diff-summary">
          <span>{review.diff.files.length} {review.diff.files.length === 1 ? "file" : "files"} vs {review.diff.base_ref?.slice(0, 8) ?? "base"}</span>
          {#if review.diff.truncated}<span>truncated</span>{/if}
        </div>
        {#if review.diff.files.length > 0}
          <div class="file-list" role="listbox" aria-label="Changed files">
            {#each review.diff.files as file (file.path)}
              <button
                type="button"
                class="file-row"
                class:current={file.path === selectedPath}
                role="option"
                aria-selected={file.path === selectedPath}
                onclick={() => void loadPatch(file.path)}
              >
                <span class="file-path">{file.path}</span>
                <span class="file-kind">{file.change_kind}</span>
                <span class="file-counts">+{file.additions} −{file.deletions}</span>
              </button>
            {/each}
          </div>
          <div class="patch-body">
            {#if patchLoading}
              <div class="empty"><Text tone="muted">Loading diff…</Text></div>
            {:else if patch?.text}
              <pre aria-label={`Unified diff for ${selectedPath}`}>{#each patchLines as line}<span class={`line ${unifiedDiffLineKind(line)}`}>{line || " "}</span>{/each}</pre>
            {:else if patch?.unavailable}
              <div class="empty"><Text tone="muted">{patch.unavailable}</Text></div>
            {/if}
          </div>
        {:else}
          <div class="empty"><Text tone="muted">No changed files on the run branch.</Text></div>
        {/if}
      {:else}
        <div class="empty"><Text tone="muted">{review.diff.unreachable_reason ?? "Diff is unavailable."}</Text></div>
      {/if}
    </section>

    <section class="review-section" aria-label="Objective">
      <h2>Objective</h2>
      <p class="objective-scope">{review.objective_scope}</p>
      {#if review.acceptance.length > 0}
        <h3>Acceptance</h3>
        <ul>{#each review.acceptance as item (item)}<li>{item}</li>{/each}</ul>
      {/if}
      {#if review.stop_conditions.length > 0}
        <h3>Stop conditions</h3>
        <ul>{#each review.stop_conditions as item (item)}<li>{item}</li>{/each}</ul>
      {/if}
    </section>

    {#if review.transitions.length > 0}
      <section class="review-section" aria-label="Transition log">
        <h2>Transition log</h2>
        <ul class="transition-list">
          {#each [...review.transitions].reverse() as transition (transition.command_id)}
            <li>
              <code>{transition.from ?? "none"}</code> → <code>{transition.to}</code>
              <span>{relativeTime(transition.at)}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if notice}<div class="notice" role="status">{notice}</div>{/if}
    {#if failure}<div class="notice error" role="alert">{failure}</div>{/if}

    <footer class="review-actions">
      {#if review.state === "delivered"}
        <Button variant="primary" size="sm" disabled={transitioning} onClick={() => void applyDisposition("accept")}>Accept</Button>
        <Button variant="secondary" size="sm" disabled={transitioning} onClick={() => void applyDisposition("reject")}>Reject</Button>
      {:else if review.state === "rejected"}
        <Button variant="secondary" size="sm" onClick={onPrepareRework}>Address changes</Button>
      {/if}
      <span class="spacer"></span>
      <Button variant="ghost" size="sm" onClick={onOpenThread}>Open worker thread</Button>
    </footer>
  {/if}
</section>

<style>
  .run-review-panel { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 0.75rem; height: 100%; min-height: 0; padding: 0.75rem; overflow: auto; color: var(--poodle-color-text-primary); }
  .review-header { display: grid; gap: 0.3rem; }
  .review-heading, .review-meta { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; min-width: 0; }
  .review-heading strong { font-size: 0.9rem; }
  .review-meta { color: var(--poodle-color-text-secondary); font-size: 0.7rem; }
  .state-badge { flex: none; padding: 0.15rem 0.35rem; border-radius: 999px; color: var(--poodle-color-text-primary); font-size: 0.62rem; text-transform: capitalize; }
  .state-delivered, .state-accepted { background: color-mix(in srgb, var(--poodle-color-success-default) 20%, transparent); }
  .state-rejected, .state-failed, .state-cancelled { background: color-mix(in srgb, var(--poodle-color-danger-default) 20%, transparent); }
  .state-running, .state-dispatched, .state-proposed { background: color-mix(in srgb, var(--poodle-color-accent-default) 18%, transparent); }
  .review-section { display: grid; gap: 0.45rem; }
  .review-section h2 { margin: 0; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--poodle-color-text-secondary); }
  .review-section h3 { margin: 0; font-size: 0.7rem; color: var(--poodle-color-text-secondary); }
  .closeout-summary, .objective-scope { margin: 0; font-size: 0.8rem; white-space: pre-wrap; }
  .evidence-board { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .validation-badge, .evidence-chip { padding: 0.22rem 0.45rem; font-size: 0.66rem; border: 1px solid var(--poodle-color-border-default); border-radius: var(--poodle-radius-control); }
  .validation-passed { color: var(--poodle-color-text-success); }
  .validation-failed { color: var(--poodle-color-text-danger); }
  .validation-missing { color: var(--poodle-color-text-muted); }
  .evidence-details summary { cursor: pointer; color: var(--poodle-color-text-secondary); font-size: 0.7rem; }
  .evidence-details ul, .review-section ul { display: grid; gap: 0.25rem; margin: 0.25rem 0 0; padding-left: 1.1rem; font-size: 0.75rem; }
  .evidence-details code { font-size: 0.68rem; }
  .diff-summary { color: var(--poodle-color-text-secondary); font-size: 0.72rem; }
  .file-list { display: grid; max-height: min(14rem, 40vh); overflow: auto; border: 1px solid var(--poodle-color-border-subtle); border-radius: var(--poodle-radius-control); }
  .file-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.42rem 0.55rem; color: var(--poodle-color-text-primary); text-align: left; border: 0; border-bottom: 1px solid var(--poodle-color-border-subtle); background: transparent; cursor: pointer; }
  .file-row:last-child { border-bottom: 0; }
  .file-row:hover, .file-row:focus, .file-row.current { outline: none; background: var(--poodle-color-background-surface); }
  .file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
  .file-kind, .file-counts { flex: none; color: var(--poodle-color-text-secondary); font-size: 0.66rem; }
  .patch-body { max-height: min(24rem, 60vh); overflow: auto; background: var(--poodle-color-background-canvas); border: 1px solid var(--poodle-color-border-subtle); border-radius: var(--poodle-radius-control); }
  pre { min-width: max-content; margin: 0; padding: 0.5rem 0; font: 0.75rem/1.5 var(--poodle-typography-font-family-mono); tab-size: 2; }
  .line { display: block; min-height: 1.5em; padding: 0 0.75rem; white-space: pre; }
  .line.added { color: var(--poodle-color-text-success); background: color-mix(in srgb, var(--poodle-color-status-success) 10%, transparent); }
  .line.deleted { color: var(--poodle-color-text-danger); background: color-mix(in srgb, var(--poodle-color-status-danger) 10%, transparent); }
  .line.hunk { color: var(--poodle-color-text-accent); background: color-mix(in srgb, var(--poodle-color-accent-base) 8%, transparent); }
  .line.header { color: var(--poodle-color-text-secondary); font-weight: 600; }
  .transition-list { display: grid; gap: 0.2rem; padding-left: 1.1rem; font-size: 0.72rem; }
  .transition-list li { display: flex; gap: 0.4rem; align-items: center; }
  .transition-list span { margin-left: auto; color: var(--poodle-color-text-muted); font-size: 0.66rem; }
  .notice { padding: 0.4rem 0.55rem; font-size: 0.75rem; color: var(--poodle-color-text-secondary); border: 1px solid var(--poodle-color-border-subtle); border-radius: var(--poodle-radius-control); }
  .notice.error { color: var(--poodle-color-text-danger); }
  .review-actions { display: flex; gap: 0.45rem; align-items: center; padding-top: 0.25rem; }
  .spacer { flex: 1; }
  .empty { display: grid; place-items: center; min-height: 6rem; padding: 1rem; text-align: center; }
</style>
