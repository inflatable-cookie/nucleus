<script lang="ts">
  import { Button, Icon, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import { onMount } from "svelte";
  import {
    readScmWorkingCopyDiff,
    type ScmWorkingCopyDiff,
  } from "./control/scmWorkingCopy";
  import { unifiedDiffLineKind } from "./diffSupport";

  let {
    projectId,
    resourceId,
    path,
    scope,
    onOpenEditor,
  }: {
    projectId: string | null;
    resourceId: string | null;
    path: string | null;
    scope: "all" | "staged" | "working";
    onOpenEditor: (fileRef: string, resourceId: string, path: string) => void;
  } = $props();

  let diff = $state<ScmWorkingCopyDiff | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let loadSequence = 0;

  const patchLines = $derived(diff?.patch?.split("\n") ?? []);
  const scopeLabel = $derived(
    scope === "staged"
      ? "Staged changes"
      : scope === "working"
        ? "Working changes"
        : "Working copy changes",
  );
  const stateLabel = $derived.by(() => {
    if (!diff) return null;
    if (diff.staged && diff.unstaged) return "staged + working";
    if (diff.staged) return "staged";
    return "working";
  });

  $effect(() => {
    projectId;
    resourceId;
    path;
    scope;
    void loadDiff();
  });

  onMount(() => {
    window.addEventListener("nucleus:editor-files-changed", handleFilesChanged);
    window.addEventListener("nucleus:scm-working-copy-changed", handleFilesChanged);
    return () => {
      window.removeEventListener("nucleus:editor-files-changed", handleFilesChanged);
      window.removeEventListener("nucleus:scm-working-copy-changed", handleFilesChanged);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  });

  async function loadDiff(): Promise<void> {
    const targetProjectId = projectId;
    const targetResourceId = resourceId;
    const targetPath = path;
    const sequence = ++loadSequence;
    diff = null;
    error = null;
    if (!targetProjectId || !targetResourceId || !targetPath) return;

    loading = true;
    try {
      const loaded = await readScmWorkingCopyDiff({
        project_id: targetProjectId,
        resource_id: targetResourceId,
        path: targetPath,
        scope,
      });
      if (sequence === loadSequence) diff = loaded;
    } catch (caught) {
      if (sequence === loadSequence) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    } finally {
      if (sequence === loadSequence) loading = false;
    }
  }

  function handleFilesChanged(event: Event): void {
    if (
      !(event instanceof CustomEvent)
      || event.detail?.project_id !== projectId
      || event.detail?.resource_id !== resourceId
    ) {
      return;
    }
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void loadDiff();
    }, 250);
  }

  function openEditor(): void {
    if (diff?.file_ref) {
      onOpenEditor(diff.file_ref, diff.resource_id, diff.path);
    }
  }
</script>

<Surface tone="canvas" border="none" padding="none" asRole="region" label="Working-copy changes">
  <div class="forge-diff-panel">
    <header class="diff-toolbar">
      <div class="summary">
        {#if diff?.original_path}<span>{diff.original_path} →</span>{/if}
        <strong>{diff?.path ?? path ?? "No changed file selected"}</strong>
        {#if diff}<span>{diff.change_kind} · {stateLabel}</span>{/if}
      </div>
      <span class="spacer"></span>
      <button
        class="toolbar-icon"
        type="button"
        aria-label="Refresh working-copy diff"
        title="Refresh"
        disabled={loading || !path}
        onclick={() => void loadDiff()}
      >
        <Icon icon={refreshCw} size="sm" />
      </button>
    </header>

    {#if diff}
      <div class="file-toolbar">
        <span class="scope">{scopeLabel}</span>
        <span class="spacer"></span>
        {#if diff.file_ref}
          <Button variant="secondary" size="sm" onClick={openEditor}>Open in Editor</Button>
        {/if}
        <span class="diff-counts">+{diff.additions} −{diff.deletions}</span>
      </div>
    {/if}

    {#if error}<div class="notice error" role="alert">{error}</div>{/if}
    {#if diff?.notice}<div class="notice" role="status">{diff.notice}</div>{/if}

    <div class="diff-body">
      {#if loading}
        <div class="empty"><Text tone="muted">Loading working-copy diff…</Text></div>
      {:else if diff?.patch}
        <pre aria-label={`Working-copy diff for ${diff.path}`}>{#each patchLines as line}<span class={`line ${unifiedDiffLineKind(line)}`}>{line || " "}</span>{/each}</pre>
      {:else if diff}
        <div class="empty"><Text tone="muted">No textual patch is available for this change.</Text></div>
      {:else if !error}
        <div class="empty"><Text tone="muted">Select a changed file in Forge.</Text></div>
      {/if}
    </div>
  </div>
</Surface>

<style>
  .forge-diff-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: var(--poodle-color-text-primary);
    container-name: forge-diff-panel;
    container-type: inline-size;
  }

  .diff-toolbar,
  .file-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.38rem 0.55rem;
    border-bottom: 1px solid var(--poodle-color-border-subtle);
  }

  .summary {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    min-width: 0;
    overflow: hidden;
  }

  .summary strong,
  .summary span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .summary span,
  .scope,
  .diff-counts {
    color: var(--poodle-color-text-muted);
    font-size: 0.78rem;
  }

  .spacer {
    flex: 1;
  }

  .toolbar-icon {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    color: var(--poodle-color-text-secondary);
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
  }

  .toolbar-icon:hover:not(:disabled) {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
  }

  .notice {
    padding: 0.35rem 0.6rem;
    color: var(--poodle-color-text-muted);
    font-size: 0.78rem;
    border-bottom: 1px solid var(--poodle-color-border-subtle);
  }

  .notice.error {
    color: var(--poodle-color-text-danger);
  }

  .diff-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--poodle-color-background-canvas);
  }

  pre {
    min-width: max-content;
    margin: 0;
    padding: 0.5rem 0;
    font: 0.78rem/1.5 var(--poodle-typography-font-family-mono);
    tab-size: 2;
  }

  .line {
    display: block;
    min-height: 1.5em;
    padding: 0 0.75rem;
    white-space: pre;
  }

  .line.added {
    color: var(--poodle-color-text-success);
    background: color-mix(in srgb, var(--poodle-color-status-success) 10%, transparent);
  }

  .line.deleted {
    color: var(--poodle-color-text-danger);
    background: color-mix(in srgb, var(--poodle-color-status-danger) 10%, transparent);
  }

  .line.hunk {
    color: var(--poodle-color-text-accent);
    background: color-mix(in srgb, var(--poodle-color-accent-base) 8%, transparent);
  }

  .line.header {
    color: var(--poodle-color-text-secondary);
    font-weight: 600;
  }

  .empty {
    display: grid;
    place-items: center;
    min-height: 100%;
    padding: 1rem;
    text-align: center;
  }

  @container forge-diff-panel (max-width: 42rem) {
    .summary span,
    .scope {
      display: none;
    }
  }
</style>
