<script lang="ts">
  import { Button, Popover, Surface, Text } from "@poodle/svelte";
  import CodeEditor from "./CodeEditor.svelte";
  import {
    admitEditorFileSwitch,
    filterEditorFiles,
    isEditorFileConflict,
    isSupportedEditorLanguage,
  } from "./editorSupport";
  import {
    listEditorFiles,
    readEditorFile,
    saveEditorFile,
    type EditorFileEntry,
    type EditorFileSnapshot,
  } from "./control/editorFiles";

  let { projectId }: { projectId: string | null } = $props();
  let files = $state<EditorFileEntry[]>([]);
  let snapshot = $state<EditorFileSnapshot | null>(null);
  let buffer = $state("");
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let quickOpen = $state(false);
  let quickOpenQuery = $state("");
  let pendingFileRef = $state<string | null>(null);
  let quickOpenResults: HTMLDivElement;
  const dirty = $derived(snapshot !== null && buffer !== snapshot.content);
  const conflict = $derived(isEditorFileConflict(error));
  const matchingFiles = $derived(filterEditorFiles(files, quickOpenQuery));

  $effect(() => {
    projectId;
    void loadFiles();
  });

  async function loadFiles(): Promise<void> {
    snapshot = null;
    buffer = "";
    files = [];
    error = null;
    pendingFileRef = null;
    quickOpen = false;
    if (!projectId) return;
    loading = true;
    try {
      files = await listEditorFiles(projectId);
      const preferred = files.find((file) => file.display_path === "README.md") ?? files[0];
      if (preferred) await readFile(preferred.file_ref);
    } catch (caught) {
      error = formatError(caught);
    } finally {
      loading = false;
    }
  }

  function requestOpen(fileRef: string): void {
    quickOpen = false;
    const admission = admitEditorFileSwitch(snapshot?.file_ref, fileRef, dirty);
    if (admission === "ignore") return;
    if (admission === "confirm") {
      pendingFileRef = fileRef;
      return;
    }
    void readFile(fileRef);
  }

  async function readFile(fileRef: string): Promise<boolean> {
    if (!projectId || !fileRef) return false;
    loading = true;
    error = null;
    try {
      snapshot = await readEditorFile(projectId, fileRef);
      buffer = snapshot.content;
      pendingFileRef = null;
      return true;
    } catch (caught) {
      error = formatError(caught);
      return false;
    } finally {
      loading = false;
    }
  }

  async function save(): Promise<boolean> {
    if (!snapshot || !dirty || saving) return false;
    saving = true;
    error = null;
    try {
      snapshot = await saveEditorFile({
        project_id: snapshot.project_id,
        file_ref: snapshot.file_ref,
        expected_content_revision: snapshot.content_revision,
        content: buffer,
      });
      buffer = snapshot.content;
      return true;
    } catch (caught) {
      error = formatError(caught);
      return false;
    } finally {
      saving = false;
    }
  }

  async function saveAndOpenPending(): Promise<void> {
    const fileRef = pendingFileRef;
    if (fileRef && (await save())) await readFile(fileRef);
  }

  function discardAndOpenPending(): void {
    const fileRef = pendingFileRef;
    pendingFileRef = null;
    if (fileRef) void readFile(fileRef);
  }

  function reloadCurrent(): void {
    if (snapshot) void readFile(snapshot.file_ref);
  }

  function handleQuickOpenKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && matchingFiles[0]) {
      event.preventDefault();
      requestOpen(matchingFiles[0].file_ref);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      quickOpenResults.querySelector<HTMLButtonElement>(".quick-open-file")?.focus();
    }
  }

  function moveQuickOpenFocus(event: KeyboardEvent, index: number): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = Array.from(quickOpenResults.querySelectorAll<HTMLButtonElement>(".quick-open-file"));
    rows[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  }

  function formatError(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }
</script>

<Surface tone="canvas" border="none" padding="none" asRole="region" label="Editor">
  <div class="editor-panel">
    <div class="editor-toolbar">
      <Popover
        bind:open={quickOpen}
        block
        disabled={!projectId || loading}
        placement="bottom-start"
        initialFocus="first-focusable"
        ariaLabel="Open project file"
        surfaceWidth="trigger"
        surfaceMaxWidth="36rem"
        onOpenChange={(open) => {
          if (open) quickOpenQuery = "";
        }}
      >
        {#snippet trigger()}
          <span class="file-trigger" title={snapshot?.display_path ?? "Open project file"}>
            {snapshot?.display_path ?? (files.length === 0 ? "No text files" : "Open file")}
          </span>
        {/snippet}
        <div class="quick-open">
          <input
            aria-label="Filter project files"
            placeholder="Find a file…"
            bind:value={quickOpenQuery}
            onkeydown={handleQuickOpenKeydown}
          />
          <div bind:this={quickOpenResults} class="quick-open-results" role="listbox" aria-label="Project files">
            {#each matchingFiles as file, index (file.file_ref)}
              <button
                class:current={file.file_ref === snapshot?.file_ref}
                class="quick-open-file"
                type="button"
                role="option"
                aria-selected={file.file_ref === snapshot?.file_ref}
                onclick={() => requestOpen(file.file_ref)}
                onkeydown={(event) => moveQuickOpenFocus(event, index)}
              >
                <span>{file.display_path}</span>
                <small>
                  {file.language_hint}{file.writable ? "" : " · read-only"} · {Math.max(1, Math.ceil(file.byte_size / 1024))} KB
                </small>
              </button>
            {:else}
              <Text tone="muted">No admitted files match.</Text>
            {/each}
          </div>
        </div>
      </Popover>
      {#if dirty}<span class="dirty" aria-label="Unsaved changes"></span>{/if}
      {#if snapshot && !snapshot.writable}<span class="status">Read-only</span>{/if}
      <span class="spacer"></span>
      <Button variant="secondary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? "Saving" : "Save"}
      </Button>
    </div>

    {#if pendingFileRef}
      <div class="editor-notice editor-decision" role="alert">
        <Text tone="muted">Save changes before opening another file?</Text>
        <span class="notice-actions">
          <Button variant="primary" size="sm" disabled={saving} onClick={() => void saveAndOpenPending()}>
            Save & open
          </Button>
          <Button variant="secondary" size="sm" disabled={saving} onClick={discardAndOpenPending}>Discard</Button>
          <Button variant="secondary" size="sm" disabled={saving} onClick={() => (pendingFileRef = null)}>Cancel</Button>
        </span>
      </div>
    {:else if conflict}
      <div class="editor-notice editor-decision" role="alert">
        <Text tone="danger">This file changed on disk. Your edits are still here.</Text>
        <span class="notice-actions">
          <Button variant="secondary" size="sm" onClick={reloadCurrent}>Reload disk</Button>
          <Button variant="secondary" size="sm" onClick={() => (error = null)}>Keep editing</Button>
        </span>
      </div>
    {:else if error}
      <div class="editor-notice error" role="alert"><Text tone="danger">{error}</Text></div>
    {/if}

    <div class="editor-body">
      {#if loading}
        <div class="editor-empty"><Text tone="muted">Loading file…</Text></div>
      {:else if snapshot}
        {#key snapshot.file_ref + snapshot.content_revision}
          <CodeEditor
            content={snapshot.content}
            languageHint={snapshot.language_hint}
            readOnly={!snapshot.writable}
            onChange={(content) => (buffer = content)}
            onSave={() => void save()}
          />
          {#if !isSupportedEditorLanguage(snapshot.language_hint)}
            <span class="plain-text-note">Plain text</span>
          {/if}
        {/key}
      {:else}
        <div class="editor-empty">
          <Text tone="muted">{projectId && files.length === 0 ? "No admitted UTF-8 text files." : "Select a project file to begin."}</Text>
        </div>
      {/if}
    </div>
  </div>
</Surface>

<style>
  .editor-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .editor-toolbar { min-height: 2.5rem; padding: 0.35rem 0.55rem; display: flex; gap: 0.5rem; align-items: center; border-bottom: 1px solid var(--poodle-color-border-subtle); }
  .editor-toolbar :global(.poodle-popover) { min-width: 0; max-width: min(36rem, 70%); }
  .file-trigger { display: block; min-width: 0; padding: 0.25rem 0.35rem; overflow: hidden; color: var(--poodle-color-text-primary); font: inherit; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .quick-open { display: grid; gap: 0.45rem; width: min(34rem, 78vw); max-width: 100%; }
  .quick-open input { box-sizing: border-box; width: 100%; padding: 0.5rem 0.6rem; color: var(--poodle-color-text-primary); font: inherit; border: 1px solid var(--poodle-color-border-subtle); border-radius: var(--poodle-radius-control); outline: none; background: var(--poodle-color-background-canvas); }
  .quick-open input:focus { border-color: var(--poodle-color-border-strong); }
  .quick-open-results { display: grid; max-height: min(22rem, 55vh); overflow: auto; }
  .quick-open-file { display: grid; gap: 0.12rem; min-width: 0; padding: 0.48rem 0.55rem; color: var(--poodle-color-text-primary); text-align: left; border: 0; border-radius: var(--poodle-radius-control); background: transparent; cursor: pointer; }
  .quick-open-file:hover, .quick-open-file:focus, .quick-open-file.current { outline: none; background: var(--poodle-color-background-surface); }
  .quick-open-file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .quick-open-file small, .status, .plain-text-note { color: var(--poodle-color-text-muted); font-size: 0.68rem; }
  .dirty { width: 0.42rem; height: 0.42rem; border-radius: 50%; background: currentColor; opacity: 0.7; }
  .spacer { flex: 1; }
  .editor-notice { padding: 0.45rem 0.65rem; border-bottom: 1px solid var(--poodle-color-border-subtle); }
  .editor-decision { display: flex; gap: 0.6rem; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .notice-actions { display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap; }
  .editor-body { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  .plain-text-note { position: absolute; right: 0.7rem; bottom: 0.55rem; pointer-events: none; }
  .editor-empty { height: 100%; display: grid; place-items: center; }

  @media (max-width: 38rem) {
    .editor-toolbar :global(.poodle-popover) { max-width: 55%; }
    .status { display: none; }
  }
</style>
