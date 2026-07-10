<script lang="ts">
  import { Button, Popover, Surface, Text } from "@poodle/svelte";
  import type { ControlTaskRecordDto } from "./control";
  import {
    querySelectedTaskReviewDecisionAdmission,
    querySelectedTaskReviewDecisionApply,
    querySelectedTaskReviewNext,
    queryTaskWorkflowDrilldown,
  } from "./control/client";
  import {
    readTaskDiffFilePatch,
    readTaskDiffOverview,
    type TaskDiffFile,
    type TaskDiffFilePatch,
    type TaskDiffOverview,
    type TaskDiffOverviewRequest,
  } from "./control/taskDiff";
  import { filterChangedFiles, latestReviewableDiff, unifiedDiffLineKind } from "./diffSupport";

  let {
    projectId,
    task,
    onOpenEditor,
    onReviewed,
  }: {
    projectId: string | null;
    task: ControlTaskRecordDto | null;
    onOpenEditor: (fileRef: string) => void;
    onReviewed: () => void;
  } = $props();

  let overview = $state<TaskDiffOverview | null>(null);
  let request = $state<TaskDiffOverviewRequest | null>(null);
  let selectedFile = $state<TaskDiffFile | null>(null);
  let patch = $state<TaskDiffFilePatch | null>(null);
  let reviewEvidenceRefs = $state<string[]>([]);
  let loading = $state(false);
  let patchLoading = $state(false);
  let reviewing = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let filePickerOpen = $state(false);
  let fileQuery = $state("");
  let reviewMenuOpen = $state(false);
  let needsChanges = $state(false);
  let reason = $state("");
  let fileResults = $state<HTMLDivElement | null>(null);

  const matchingFiles = $derived(filterChangedFiles(overview?.files ?? [], fileQuery));
  const patchLines = $derived(patch?.patch?.split("\n") ?? []);

  $effect(() => {
    projectId;
    task?.task_id;
    task?.revision_id;
    void loadDiff();
  });

  async function loadDiff(): Promise<void> {
    overview = null;
    request = null;
    selectedFile = null;
    patch = null;
    reviewEvidenceRefs = [];
    error = null;
    notice = null;
    if (!projectId || !task) return;

    loading = true;
    try {
      const [drilldownResult, reviewResult] = await Promise.all([
        queryTaskWorkflowDrilldown(projectId, task.task_id),
        querySelectedTaskReviewNext(projectId, task.task_id),
      ]);
      if (drilldownResult.state !== "record" || reviewResult.state !== "record") {
        notice = "No reviewable task diff is available yet.";
        return;
      }

      const target = latestReviewableDiff(
        drilldownResult.drilldown.work_progress.work_items,
        reviewResult.reviewNext.review.work_item_refs,
        reviewResult.reviewNext.evidence.diff_summary_refs,
      );
      if (!target) {
        notice = "This task has no diff in its current review evidence.";
        return;
      }

      reviewEvidenceRefs = reviewResult.reviewNext.review.evidence_refs;
      request = {
        project_id: projectId,
        task_id: task.task_id,
        work_item_id: target.workItemId,
        diff_id: target.diffId,
      };
      overview = await readTaskDiffOverview(request);
      const firstFile = overview.files[0] ?? null;
      selectedFile = firstFile;
      if (firstFile) await loadPatch(firstFile);
    } catch (caught) {
      error = formatError(caught);
    } finally {
      loading = false;
    }
  }

  async function loadPatch(file: TaskDiffFile): Promise<void> {
    if (!request) return;
    selectedFile = file;
    patch = null;
    error = null;
    filePickerOpen = false;
    patchLoading = true;
    try {
      patch = await readTaskDiffFilePatch({ ...request, file_ref: file.file_ref });
    } catch (caught) {
      error = formatError(caught);
    } finally {
      patchLoading = false;
    }
  }

  async function applyReview(action: "accept_evidence" | "request_changes"): Promise<void> {
    if (!projectId || !task || !request || reviewing) return;
    const reviewReason = action === "request_changes" ? reason.trim() : null;
    if (action === "request_changes" && !reviewReason) {
      error = "Describe what needs to change before applying the review.";
      return;
    }

    reviewing = true;
    error = null;
    try {
      const key = `diff-panel:${action}:${task.revision_id}:${Date.now()}`;
      const admission = await querySelectedTaskReviewDecisionAdmission(
        projectId,
        task.task_id,
        action,
        task.revision_id,
        reviewReason,
        reviewEvidenceRefs,
        `${key}:preview`,
      );
      if (admission.state !== "record" || admission.admission.status !== "admitted") {
        error = admission.state === "record"
          ? admission.admission.refusal?.reason ?? "This review decision was not admitted."
          : fallbackMessage(admission);
        return;
      }

      const result = await querySelectedTaskReviewDecisionApply(
        projectId,
        task.task_id,
        action,
        task.revision_id,
        reviewReason,
        reviewEvidenceRefs,
        `${key}:apply`,
      );
      if (result.state !== "record") {
        error = fallbackMessage(result);
        return;
      }

      const successNotice = action === "accept_evidence" ? "Evidence accepted." : "Changes requested.";
      reason = "";
      needsChanges = false;
      reviewMenuOpen = false;
      window.dispatchEvent(new CustomEvent("nucleus:tasks-changed", { detail: { projectId } }));
      onReviewed();
      await loadDiff();
      notice = successNotice;
    } catch (caught) {
      error = formatError(caught);
    } finally {
      reviewing = false;
    }
  }

  function handleFileFilterKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && matchingFiles[0]) {
      event.preventDefault();
      void loadPatch(matchingFiles[0]);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      fileResults?.querySelector<HTMLButtonElement>(".file-option")?.focus();
    }
  }

  function moveFileFocus(event: KeyboardEvent, index: number): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = Array.from(fileResults?.querySelectorAll<HTMLButtonElement>(".file-option") ?? []);
    rows[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  }

  function fallbackMessage(result: { state: string; reason?: string; kind?: string }): string {
    return result.reason ?? `Review ${result.state}.`;
  }

  function formatError(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  function openSelectedFile(): void {
    if (selectedFile) onOpenEditor(selectedFile.file_ref);
  }
</script>

<Surface tone="canvas" border="none" padding="none" asRole="region" label="Task diff review">
  <div class="diff-panel">
    <header class="diff-toolbar">
      <div class="summary">
        <strong>{task?.title ?? "No task selected"}</strong>
        {#if overview}
          <span>{overview.summary}</span>
        {/if}
      </div>
      <span class="spacer"></span>
      {#if overview && request}
        <Popover bind:open={reviewMenuOpen} placement="bottom-end" initialFocus="first-focusable" ariaLabel="Review task evidence">
          {#snippet trigger()}<span class="menu-trigger">Review</span>{/snippet}
          <div class="review-menu">
            {#if needsChanges}
              <label for="review-reason">Needs changes</label>
              <textarea id="review-reason" rows="3" placeholder="What should change?" bind:value={reason}></textarea>
              <div class="menu-actions">
                <Button variant="secondary" size="sm" onClick={() => (needsChanges = false)}>Back</Button>
                <Button variant="primary" size="sm" disabled={!reason.trim() || reviewing} onClick={() => void applyReview("request_changes")}>Apply</Button>
              </div>
            {:else}
              <button type="button" class="menu-option" disabled={reviewing} onclick={() => void applyReview("accept_evidence")}>Accept evidence</button>
              <button type="button" class="menu-option" disabled={reviewing} onclick={() => (needsChanges = true)}>Needs changes…</button>
            {/if}
          </div>
        </Popover>
      {/if}
    </header>

    {#if overview}
      <div class="file-toolbar">
        <Popover bind:open={filePickerOpen} block placement="bottom-start" initialFocus="first-focusable" ariaLabel="Choose changed file" surfaceWidth="trigger" onOpenChange={(open) => { if (open) fileQuery = ""; }}>
          {#snippet trigger()}<span class="file-trigger" title={selectedFile?.display_path}>{selectedFile?.display_path ?? "No changed files"}</span>{/snippet}
          <div class="file-picker">
            <input aria-label="Filter changed files" placeholder="Find changed file…" bind:value={fileQuery} onkeydown={handleFileFilterKeydown} />
            <div bind:this={fileResults} class="file-results" role="listbox" aria-label="Changed files">
              {#each matchingFiles as file, index (file.file_ref)}
                <button type="button" class="file-option" class:current={file.file_ref === selectedFile?.file_ref} role="option" aria-selected={file.file_ref === selectedFile?.file_ref} onclick={() => void loadPatch(file)} onkeydown={(event) => moveFileFocus(event, index)}>
                  <span>{file.display_path}</span><small>{file.change_kind}</small>
                </button>
              {:else}<Text tone="muted">No changed files match.</Text>{/each}
            </div>
          </div>
        </Popover>
        {#if selectedFile}
          <Button variant="secondary" size="sm" onClick={openSelectedFile}>Open in Editor</Button>
        {/if}
        <span class="diff-counts">+{patch?.additions ?? 0} −{patch?.deletions ?? 0}</span>
      </div>
    {/if}

    {#if error}<div class="notice error" role="alert">{error}</div>{/if}
    {#if notice}<div class="notice" role="status">{notice}</div>{/if}
    {#if overview?.attribution_notice}<div class="notice">{overview.attribution_notice}</div>{/if}
    {#if overview && (overview.coverage !== "complete" || overview.truncated)}
      <div class="notice">Evidence coverage: {overview.coverage}{overview.truncated ? " · summary truncated" : ""}</div>
    {/if}

    <div class="diff-body">
      {#if loading || patchLoading}
        <div class="empty"><Text tone="muted">Loading task diff…</Text></div>
      {:else if !task}
        <div class="empty"><Text tone="muted">Select a task to inspect its evidence.</Text></div>
      {:else if patch?.patch}
        <pre aria-label={`Unified diff for ${patch.display_path}`}>{#each patchLines as line}<span class={`line ${unifiedDiffLineKind(line)}`}>{line || " "}</span>{/each}</pre>
      {:else if patch}
        <div class="empty"><Text tone="muted">{patch.display_path} is {patch.state}. No text patch is available.</Text></div>
      {:else}
        <div class="empty"><Text tone="muted">{notice ?? "No changed file selected."}</Text></div>
      {/if}
    </div>
  </div>
</Surface>

<style>
  .diff-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--poodle-color-text-primary); }
  .diff-toolbar, .file-toolbar { display: flex; align-items: center; gap: .5rem; min-width: 0; padding: .38rem .55rem; border-bottom: 1px solid var(--poodle-color-border-subtle); }
  .summary { display: flex; align-items: baseline; gap: .55rem; min-width: 0; overflow: hidden; }
  .summary strong, .summary span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .summary span, .diff-counts { color: var(--poodle-color-text-secondary); font-size: .78rem; }
  .spacer { flex: 1; }
  .menu-trigger, .file-trigger { display: block; padding: .3rem .4rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .file-toolbar :global(.poodle-popover) { min-width: 0; max-width: min(34rem, 65%); }
  .file-trigger { min-width: 8rem; }
  .file-picker { display: grid; gap: .4rem; width: min(32rem, 78vw); }
  .file-picker input, .review-menu textarea { box-sizing: border-box; width: 100%; padding: .48rem .55rem; color: var(--poodle-color-text-primary); font: inherit; border: 1px solid var(--poodle-color-border-subtle); border-radius: var(--poodle-radius-control); background: var(--poodle-color-background-canvas); }
  .file-results { display: grid; max-height: min(22rem, 55vh); overflow: auto; }
  .file-option, .menu-option { display: flex; justify-content: space-between; gap: 1rem; padding: .48rem .55rem; color: var(--poodle-color-text-primary); text-align: left; border: 0; border-radius: var(--poodle-radius-control); background: transparent; cursor: pointer; }
  .file-option:hover, .file-option:focus, .file-option.current, .menu-option:hover, .menu-option:focus { outline: none; background: var(--poodle-color-background-surface); }
  .file-option small { color: var(--poodle-color-text-secondary); }
  .review-menu { display: grid; gap: .4rem; width: min(20rem, 70vw); }
  .review-menu label { font-weight: 600; }
  .menu-actions { display: flex; justify-content: flex-end; gap: .4rem; }
  .notice { padding: .35rem .6rem; color: var(--poodle-color-text-secondary); font-size: .78rem; border-bottom: 1px solid var(--poodle-color-border-subtle); }
  .notice.error { color: var(--poodle-color-text-danger); }
  .diff-body { flex: 1; min-height: 0; overflow: auto; background: var(--poodle-color-background-canvas); }
  pre { min-width: max-content; margin: 0; padding: .5rem 0; font: .78rem/1.5 var(--poodle-typography-font-family-mono); tab-size: 2; }
  .line { display: block; min-height: 1.5em; padding: 0 .75rem; white-space: pre; }
  .line.added { color: var(--poodle-color-text-success); background: color-mix(in srgb, var(--poodle-color-status-success) 10%, transparent); }
  .line.deleted { color: var(--poodle-color-text-danger); background: color-mix(in srgb, var(--poodle-color-status-danger) 10%, transparent); }
  .line.hunk { color: var(--poodle-color-text-accent); background: color-mix(in srgb, var(--poodle-color-accent-base) 8%, transparent); }
  .line.header { color: var(--poodle-color-text-secondary); font-weight: 600; }
  .empty { display: grid; place-items: center; min-height: 100%; padding: 1rem; text-align: center; }
  @media (max-width: 42rem) { .summary span { display: none; } .file-toolbar :global(.poodle-popover) { max-width: 55%; } .file-trigger { min-width: 0; } }
</style>
