<script lang="ts">
  import { Button, Icon, Popover, Surface, Text } from "@inflatable-cookie/poodle-svelte";
  import { folderOpen } from "@inflatable-cookie/poodle-core/icons";
  import { onDestroy, onMount, untrack } from "svelte";
  import CodeEditor from "./CodeEditor.svelte";
  import {
    admitEditorFileSwitch,
    classifyEditorDraftRecovery,
    classifyExternalEditorFileChange,
    editorFileWatchTouchesPath,
    isEditorFileConflict,
    isSupportedEditorLanguage,
  } from "./editorSupport";
  import {
    readEditorFile,
    saveEditorFile,
    searchEditorFiles,
    type EditorFileMoveReceipt,
    type EditorFileEntry,
    type EditorFileSnapshot,
  } from "./control/editorFiles";
  import {
    deleteEditorDraft,
    loadEditorDraft,
    saveEditorDraft,
    type EditorDraftDto,
  } from "./control/editorDrafts";
  import type { EditorFileWatchEvent } from "./control/editorFileWatch";
  import {
    requestEditorFileReveal,
    setActiveEditorFile,
    type ActiveEditorFile,
  } from "./editorNavigation";

  let {
    projectId,
    resourceId = null,
    requestedFileRef = null,
    requestedFilePath = null,
    onFileOpen,
  }: {
    projectId: string | null;
    resourceId?: string | null;
    requestedFileRef?: string | null;
    requestedFilePath?: string | null;
    onFileOpen?: (file: {
      resourceId: string;
      fileRef: string;
      displayPath: string;
    }) => void;
  } = $props();
  let files = $state<EditorFileEntry[]>([]);
  let filesLoading = $state(false);
  let snapshot = $state<EditorFileSnapshot | null>(null);
  let buffer = $state("");
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let quickOpen = $state(false);
  let quickOpenQuery = $state("");
  let pendingFileRequest = $state<{
    fileRef: string;
    displayPath: string | null;
  } | null>(null);
  let quickOpenResults: HTMLDivElement;
  let fileSearchSequence = 0;
  let fileSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let fileProbeSequence = 0;
  let fileProbeTimer: ReturnType<typeof setTimeout> | null = null;
  let diskSnapshot = $state<EditorFileSnapshot | null>(null);
  let diskUnavailable = $state<string | null>(null);
  let diskNoticeDismissed = $state(false);
  let comparingDisk = $state(false);
  let draftError = $state<string | null>(null);
  let draftRecovered = $state(false);
  let draftPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let draftOperation: Promise<void> = Promise.resolve();
  let readSequence = 0;
  const dirty = $derived(snapshot !== null && buffer !== snapshot.content);
  const conflict = $derived(isEditorFileConflict(error));

  $effect(() => {
    window.dispatchEvent(new CustomEvent("nucleus:editor-command-state", {
      detail: { dirty },
    }));
  });

  $effect(() => {
    projectId;
    resourceId;
    untrack(resetEditor);
  });

  $effect(() => {
    const fileRef = requestedFileRef;
    const displayPath = requestedFilePath;
    if (fileRef) {
      untrack(() => requestOpen(fileRef, displayPath));
    }
  });

  onDestroy(() => {
    flushDraftPersistence();
    cancelQuickOpenSearch();
    cancelExternalFileProbe();
  });
  onMount(() => {
    window.addEventListener("nucleus:editor-files-changed", handleEditorFilesChanged);
    window.addEventListener("nucleus:editor-file-renamed", handleEditorFileRenamed);
    window.addEventListener("nucleus:editor-file-deleted", handleEditorFileDeleted);
    window.addEventListener("nucleus:editor-directory-renamed", handleEditorDirectoryRenamed);
    window.addEventListener("nucleus:editor-directory-deleted", handleEditorDirectoryDeleted);
    window.addEventListener("nucleus:command-editor-quick-open", commandQuickOpen);
    window.addEventListener("nucleus:command-editor-save", commandSave);
    return () => {
      window.removeEventListener("nucleus:editor-files-changed", handleEditorFilesChanged);
      window.removeEventListener("nucleus:editor-file-renamed", handleEditorFileRenamed);
      window.removeEventListener("nucleus:editor-file-deleted", handleEditorFileDeleted);
      window.removeEventListener("nucleus:editor-directory-renamed", handleEditorDirectoryRenamed);
      window.removeEventListener("nucleus:editor-directory-deleted", handleEditorDirectoryDeleted);
      window.removeEventListener("nucleus:command-editor-quick-open", commandQuickOpen);
      window.removeEventListener("nucleus:command-editor-save", commandSave);
    };
  });

  function resetEditor(): void {
    flushDraftPersistence();
    cancelQuickOpenSearch();
    cancelExternalFileProbe();
    readSequence += 1;
    snapshot = null;
    buffer = "";
    files = [];
    filesLoading = false;
    error = null;
    pendingFileRequest = null;
    quickOpen = false;
    loading = false;
    draftError = null;
    draftRecovered = false;
    clearExternalFileState();
  }

  function commandQuickOpen(): void {
    if (projectId && !loading) quickOpen = true;
  }

  function commandSave(): void {
    if (dirty) void save();
  }

  function handleBufferChange(content: string): void {
    buffer = content;
    scheduleDraftPersistence();
  }

  function scheduleDraftPersistence(): void {
    if (draftPersistTimer !== null) {
      clearTimeout(draftPersistTimer);
    }
    draftPersistTimer = setTimeout(() => {
      draftPersistTimer = null;
      persistCurrentDraft();
    }, 250);
  }

  function flushDraftPersistence(): void {
    if (draftPersistTimer !== null) {
      clearTimeout(draftPersistTimer);
      draftPersistTimer = null;
    }
    persistCurrentDraft();
  }

  function persistCurrentDraft(): void {
    const opened = snapshot;
    const content = buffer;
    if (!opened) return;
    if (content === opened.content) {
      queueDraftDelete(opened);
      return;
    }
    queueDraftOperation(() => saveEditorDraft({
      schema_version: 1,
      snapshot: { ...opened },
      content,
    }));
  }

  function persistOrphanedBuffer(): void {
    if (draftPersistTimer !== null) {
      clearTimeout(draftPersistTimer);
      draftPersistTimer = null;
    }
    const opened = snapshot;
    if (!opened) return;
    queueDraftOperation(() => saveEditorDraft({
      schema_version: 1,
      snapshot: { ...opened },
      content: buffer,
    }));
  }

  function queueDraftDelete(opened: EditorFileSnapshot): void {
    queueDraftOperation(() => deleteEditorDraft(
      opened.project_id,
      opened.resource_id,
      opened.file_ref,
    ));
  }

  function queueDraftOperation(operation: () => Promise<void>): void {
    draftOperation = draftOperation
      .then(async () => {
        await operation();
        draftError = null;
      })
      .catch((caught) => {
        draftError = formatError(caught);
      });
  }

  async function recoverDraft(
    projectId: string,
    resourceId: string,
    fileRef: string,
  ): Promise<EditorDraftDto | null> {
    await draftOperation;
    try {
      return await loadEditorDraft(projectId, resourceId, fileRef);
    } catch (caught) {
      draftError = formatError(caught);
      return null;
    }
  }

  function applyOpenedFile(
    opened: EditorFileSnapshot,
    draft: EditorDraftDto | null,
  ): void {
    draftRecovered = false;
    if (!draft) {
      snapshot = opened;
      buffer = opened.content;
      clearExternalFileState();
      return;
    }

    const recovery = classifyEditorDraftRecovery(
      draft.snapshot.content_revision,
      draft.snapshot.content,
      draft.content,
      opened.content_revision,
      opened.content,
    );
    if (recovery === "discard") {
      snapshot = opened;
      buffer = opened.content;
      queueDraftDelete(opened);
      clearExternalFileState();
      return;
    }

    draftRecovered = true;
    buffer = draft.content;
    if (recovery === "restore") {
      snapshot = opened;
      clearExternalFileState();
      return;
    }

    snapshot = draft.snapshot;
    diskSnapshot = opened;
    diskUnavailable = null;
    diskNoticeDismissed = false;
    comparingDisk = false;
  }

  function cancelQuickOpenSearch(): void {
    fileSearchSequence += 1;
    if (fileSearchTimer !== null) {
      clearTimeout(fileSearchTimer);
      fileSearchTimer = null;
    }
  }

  function scheduleQuickOpenSearch(): void {
    cancelQuickOpenSearch();
    fileSearchTimer = setTimeout(() => {
      fileSearchTimer = null;
      void searchQuickOpenFiles(quickOpenQuery);
    }, 120);
  }

  function cancelExternalFileProbe(): void {
    fileProbeSequence += 1;
    if (fileProbeTimer !== null) {
      clearTimeout(fileProbeTimer);
      fileProbeTimer = null;
    }
  }

  function scheduleExternalFileProbe(): void {
    cancelExternalFileProbe();
    fileProbeTimer = setTimeout(() => {
      fileProbeTimer = null;
      void probeExternalFile();
    }, 140);
  }

  async function probeExternalFile(): Promise<void> {
    const openedSnapshot = snapshot;
    if (!projectId || !openedSnapshot) return;
    const sequence = ++fileProbeSequence;
    const requestedProjectId = projectId;
    const requestedResourceId = resourceId;
    try {
      const disk = await readEditorFile(
        requestedProjectId,
        requestedResourceId,
        openedSnapshot.file_ref,
        openedSnapshot.display_path,
      );
      if (
        sequence !== fileProbeSequence
        || projectId !== requestedProjectId
        || resourceId !== requestedResourceId
        || snapshot?.file_ref !== openedSnapshot.file_ref
        || snapshot.content_revision !== openedSnapshot.content_revision
      ) {
        return;
      }
      switch (classifyExternalEditorFileChange(
        openedSnapshot.content_revision,
        openedSnapshot.content,
        buffer,
        disk.content_revision,
      )) {
        case "ignore":
          clearExternalFileState();
          break;
        case "reload":
          snapshot = disk;
          buffer = disk.content;
          clearExternalFileState();
          break;
        case "preserve_buffer":
          diskSnapshot = disk;
          diskUnavailable = null;
          diskNoticeDismissed = false;
          if (isEditorFileConflict(error)) error = null;
          break;
      }
    } catch (caught) {
      if (
        sequence === fileProbeSequence
        && projectId === requestedProjectId
        && resourceId === requestedResourceId
        && snapshot?.file_ref === openedSnapshot.file_ref
        && snapshot.content_revision === openedSnapshot.content_revision
      ) {
        diskSnapshot = null;
        diskUnavailable = formatError(caught);
        diskNoticeDismissed = false;
        comparingDisk = false;
        if (isEditorFileConflict(error)) error = null;
      }
    }
  }

  async function searchQuickOpenFiles(query: string): Promise<void> {
    if (!projectId) return;
    const sequence = ++fileSearchSequence;
    const requestedProjectId = projectId;
    const requestedResourceId = resourceId;
    filesLoading = true;
    try {
      const loaded = await searchEditorFiles(
        requestedProjectId,
        requestedResourceId,
        query,
      );
      if (
        sequence === fileSearchSequence
        && quickOpen
        && projectId === requestedProjectId
        && resourceId === requestedResourceId
      ) {
        files = loaded;
      }
    } catch (caught) {
      if (sequence === fileSearchSequence && quickOpen) {
        error = formatError(caught);
      }
    } finally {
      if (sequence === fileSearchSequence) {
        filesLoading = false;
      }
    }
  }

  function requestOpen(fileRef: string, displayPath: string | null = null): void {
    quickOpen = false;
    const admission = admitEditorFileSwitch(snapshot?.file_ref, fileRef, dirty);
    if (admission === "ignore") return;
    if (admission === "confirm") {
      pendingFileRequest = { fileRef, displayPath };
      return;
    }
    void readFile(fileRef, displayPath);
  }

  async function readFile(
    fileRef: string,
    displayPath: string | null = null,
  ): Promise<boolean> {
    if (!projectId || !fileRef) return false;
    const sequence = ++readSequence;
    const requestedProjectId = projectId;
    const requestedResourceId = resourceId;
    loading = true;
    error = null;
    try {
      const opened = await readEditorFile(
        requestedProjectId,
        requestedResourceId,
        fileRef,
        displayPath,
      );
      if (
        sequence !== readSequence
        || projectId !== requestedProjectId
        || resourceId !== requestedResourceId
      ) {
        return false;
      }
      const draft = await recoverDraft(
        opened.project_id,
        opened.resource_id,
        opened.file_ref,
      );
      if (
        sequence !== readSequence
        || projectId !== requestedProjectId
        || resourceId !== requestedResourceId
      ) {
        return false;
      }
      applyOpenedFile(opened, draft);
      pendingFileRequest = null;
      publishActiveFile(opened);
      onFileOpen?.({
        resourceId: opened.resource_id,
        fileRef: opened.file_ref,
        displayPath: opened.display_path,
      });
      return true;
    } catch (caught) {
      if (
        sequence === readSequence
        && projectId === requestedProjectId
        && resourceId === requestedResourceId
      ) {
        const draft = requestedResourceId
          ? await recoverDraft(requestedProjectId, requestedResourceId, fileRef)
          : null;
        if (
          draft
          && sequence === readSequence
          && projectId === requestedProjectId
          && resourceId === requestedResourceId
        ) {
          snapshot = draft.snapshot;
          buffer = draft.content;
          draftRecovered = true;
          diskSnapshot = null;
          diskUnavailable = formatError(caught);
          diskNoticeDismissed = false;
          comparingDisk = false;
          error = null;
          publishActiveFile(draft.snapshot);
          onFileOpen?.({
            resourceId: draft.snapshot.resource_id,
            fileRef: draft.snapshot.file_ref,
            displayPath: draft.snapshot.display_path,
          });
          return true;
        }
        error = formatError(caught);
      }
      return false;
    } finally {
      if (sequence === readSequence) {
        loading = false;
      }
    }
  }

  async function save(): Promise<boolean> {
    if (!snapshot || !dirty || saving) return false;
    if (draftPersistTimer !== null) {
      clearTimeout(draftPersistTimer);
      draftPersistTimer = null;
    }
    saving = true;
    error = null;
    try {
      snapshot = await saveEditorFile({
        project_id: snapshot.project_id,
        resource_id: snapshot.resource_id,
        file_ref: snapshot.file_ref,
        display_path: snapshot.display_path,
        expected_content_revision: snapshot.content_revision,
        content: buffer,
      });
      buffer = snapshot.content;
      draftRecovered = false;
      queueDraftDelete(snapshot);
      clearExternalFileState();
      return true;
    } catch (caught) {
      error = formatError(caught);
      if (isEditorFileConflict(error)) {
        void probeExternalFile();
      }
      return false;
    } finally {
      saving = false;
    }
  }

  async function saveAndOpenPending(): Promise<void> {
    const request = pendingFileRequest;
    if (request && (await save())) {
      await readFile(request.fileRef, request.displayPath);
    }
  }

  function discardAndOpenPending(): void {
    const request = pendingFileRequest;
    pendingFileRequest = null;
    if (snapshot) queueDraftDelete(snapshot);
    if (request) void readFile(request.fileRef, request.displayPath);
  }

  function reloadCurrent(): void {
    if (snapshot) void readFile(snapshot.file_ref, snapshot.display_path);
  }

  function reloadDiskSnapshot(): void {
    if (!diskSnapshot) {
      reloadCurrent();
      return;
    }
    readSequence += 1;
    if (snapshot) queueDraftDelete(snapshot);
    snapshot = diskSnapshot;
    buffer = diskSnapshot.content;
    draftRecovered = false;
    error = null;
    clearExternalFileState();
  }

  function clearExternalFileState(): void {
    diskSnapshot = null;
    diskUnavailable = null;
    diskNoticeDismissed = false;
    comparingDisk = false;
  }

  function handleQuickOpenKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && files[0]) {
      event.preventDefault();
      requestOpen(files[0].file_ref, files[0].display_path);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      quickOpenResults.querySelector<HTMLButtonElement>(".quick-open-file")?.focus();
    }
  }

  function handleEditorFilesChanged(event: Event): void {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as EditorFileWatchEvent;
    if (
      detail.kind !== "changed"
      || detail.project_id !== projectId
      || (resourceId !== null && detail.resource_id !== resourceId)
    ) {
      return;
    }
    if (quickOpen) {
      scheduleQuickOpenSearch();
    }
    if (
      snapshot
      && editorFileWatchTouchesPath(detail.paths, snapshot.display_path)
    ) {
      scheduleExternalFileProbe();
    }
  }

  function handleEditorFileRenamed(event: Event): void {
    if (!(event instanceof CustomEvent) || !snapshot) return;
    const detail = event.detail as {
      projectId: string;
      resourceId: string;
      fileRef: string;
      displayPath: string;
      snapshot: EditorFileSnapshot;
    };
    if (
      detail.projectId !== snapshot.project_id
      || detail.resourceId !== snapshot.resource_id
      || detail.fileRef !== snapshot.file_ref
      || detail.displayPath !== snapshot.display_path
    ) {
      return;
    }

    const hadChanges = dirty;
    flushDraftPersistence();
    queueDraftDelete(snapshot);
    readSequence += 1;
    snapshot = detail.snapshot;
    if (!hadChanges) {
      buffer = detail.snapshot.content;
      draftRecovered = false;
      queueDraftDelete(detail.snapshot);
    } else {
      scheduleDraftPersistence();
    }
    error = null;
    clearExternalFileState();
    publishActiveFile(detail.snapshot);
    onFileOpen?.({
      resourceId: detail.snapshot.resource_id,
      fileRef: detail.snapshot.file_ref,
      displayPath: detail.snapshot.display_path,
    });
  }

  function handleEditorFileDeleted(event: Event): void {
    if (!(event instanceof CustomEvent) || !snapshot) return;
    const detail = event.detail as {
      projectId: string;
      resourceId: string;
      fileRef: string;
      displayPath: string;
    };
    if (
      detail.projectId !== snapshot.project_id
      || detail.resourceId !== snapshot.resource_id
      || detail.fileRef !== snapshot.file_ref
      || detail.displayPath !== snapshot.display_path
    ) {
      return;
    }

    persistOrphanedBuffer();
    diskSnapshot = null;
    diskUnavailable = "This file was deleted. Your open buffer is still available.";
    diskNoticeDismissed = false;
    comparingDisk = false;
    error = null;
  }

  function handleEditorDirectoryRenamed(event: Event): void {
    if (!(event instanceof CustomEvent) || !snapshot) return;
    const detail = event.detail as {
      projectId: string;
      resourceId: string;
      displayPath: string;
      targetDisplayPath: string;
      files: EditorFileMoveReceipt[];
    };
    if (
      detail.projectId !== snapshot.project_id
      || detail.resourceId !== snapshot.resource_id
    ) {
      return;
    }
    const moved = detail.files.find((candidate) =>
      candidate.file_ref === snapshot?.file_ref
      && candidate.display_path === snapshot.display_path
    );
    if (!moved) return;

    const hadChanges = dirty;
    flushDraftPersistence();
    queueDraftDelete(snapshot);
    readSequence += 1;
    snapshot = {
      ...snapshot,
      file_ref: moved.target_file_ref,
      display_path: moved.target_display_path,
      language_hint: moved.language_hint,
    };
    if (hadChanges) {
      scheduleDraftPersistence();
    } else {
      queueDraftDelete(snapshot);
    }
    error = null;
    clearExternalFileState();
    publishActiveFile(snapshot);
    onFileOpen?.({
      resourceId: snapshot.resource_id,
      fileRef: snapshot.file_ref,
      displayPath: snapshot.display_path,
    });
  }

  function handleEditorDirectoryDeleted(event: Event): void {
    if (!(event instanceof CustomEvent) || !snapshot) return;
    const detail = event.detail as {
      projectId: string;
      resourceId: string;
      displayPath: string;
    };
    if (
      detail.projectId !== snapshot.project_id
      || detail.resourceId !== snapshot.resource_id
      || !pathIsWithin(snapshot.display_path, detail.displayPath)
    ) {
      return;
    }

    persistOrphanedBuffer();
    diskSnapshot = null;
    diskUnavailable = "This file's folder was deleted. Your open buffer is still available.";
    diskNoticeDismissed = false;
    comparingDisk = false;
    error = null;
  }

  function pathIsWithin(displayPath: string, directoryPath: string): boolean {
    return displayPath.startsWith(`${directoryPath.replace(/\/+$/, "")}/`);
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

  function activeFile(opened: EditorFileSnapshot): ActiveEditorFile {
    return {
      projectId: opened.project_id,
      resourceId: opened.resource_id,
      fileRef: opened.file_ref,
      displayPath: opened.display_path,
    };
  }

  function publishActiveFile(opened: EditorFileSnapshot): void {
    setActiveEditorFile(activeFile(opened));
  }

  function revealActiveFile(): void {
    if (snapshot) requestEditorFileReveal(activeFile(snapshot));
  }
</script>

<div class="editor-surface">
  <Surface tone="canvas" border="none" padding="none" asRole="region" label="Editor">
    <div
      class="editor-panel"
      onfocusin={() => {
        if (snapshot) publishActiveFile(snapshot);
      }}
    >
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
          if (open) {
            quickOpenQuery = "";
            files = [];
            void searchQuickOpenFiles("");
          } else {
            cancelQuickOpenSearch();
          }
        }}
      >
        {#snippet trigger()}
          <span class="file-trigger" title={snapshot?.display_path ?? "Open project file"}>
            {snapshot?.display_path ?? "Open file"}
          </span>
        {/snippet}
        <div class="quick-open">
          <input
            aria-label="Filter project files"
            placeholder="Find a file…"
            value={quickOpenQuery}
            oninput={(event) => {
              quickOpenQuery = event.currentTarget.value;
              scheduleQuickOpenSearch();
            }}
            onkeydown={handleQuickOpenKeydown}
          />
          <div bind:this={quickOpenResults} class="quick-open-results" role="listbox" aria-label="Project files">
            {#if filesLoading}
              <Text tone="muted">Searching project files…</Text>
            {:else}
              {#each files as file, index (file.file_ref)}
                <button
                  class:current={file.file_ref === snapshot?.file_ref}
                  class="quick-open-file"
                  type="button"
                  role="option"
                  aria-selected={file.file_ref === snapshot?.file_ref}
                  onclick={() => requestOpen(file.file_ref, file.display_path)}
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
            {/if}
          </div>
        </div>
      </Popover>
      {#if dirty}<span class="dirty" aria-label="Unsaved changes"></span>{/if}
      {#if snapshot && !snapshot.writable}<span class="status">Read-only</span>{/if}
      {#if draftRecovered}<span class="status">Recovered draft</span>{/if}
      {#if draftError}<span class="status" title={draftError}>Recovery unavailable</span>{/if}
      {#if diskSnapshot || diskUnavailable}
        <button
          class="disk-status"
          type="button"
          onclick={() => (diskNoticeDismissed = false)}
        >
          {diskSnapshot ? "Disk changed" : "Disk unavailable"}
        </button>
      {/if}
      <span class="spacer"></span>
      <button
        class="editor-toolbar-icon"
        type="button"
        aria-label="Reveal in Files"
        title="Reveal in Files"
        disabled={!snapshot}
        onclick={revealActiveFile}
      >
        <Icon icon={folderOpen} size="sm" />
      </button>
      <Button variant="secondary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? "Saving" : "Save"}
      </Button>
    </div>

    {#if pendingFileRequest}
      <div class="editor-notice editor-decision" role="alert">
        <Text tone="muted">Save changes before opening another file?</Text>
        <span class="notice-actions">
          <Button variant="primary" size="sm" disabled={saving} onClick={() => void saveAndOpenPending()}>
            Save & open
          </Button>
          <Button variant="secondary" size="sm" disabled={saving} onClick={discardAndOpenPending}>Discard</Button>
          <Button variant="secondary" size="sm" disabled={saving} onClick={() => (pendingFileRequest = null)}>Cancel</Button>
        </span>
      </div>
    {:else if !diskNoticeDismissed && (diskSnapshot || diskUnavailable)}
      <div class="editor-notice editor-decision" role="alert">
        <Text tone="danger">
          {diskSnapshot
            ? "This file changed on disk. Your edits are still here."
            : "This file is no longer available on disk. Your buffer is still here."}
        </Text>
        <span class="notice-actions">
          {#if diskSnapshot}
            <Button variant="secondary" size="sm" onClick={() => (comparingDisk = true)}>Compare</Button>
            <Button variant="secondary" size="sm" onClick={reloadDiskSnapshot}>Reload disk</Button>
          {/if}
          <Button variant="secondary" size="sm" onClick={() => (diskNoticeDismissed = true)}>Keep editing</Button>
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
      {#if comparingDisk && snapshot && diskSnapshot}
        <div class="editor-comparison">
          <header>
            <strong>Comparing {snapshot.display_path}</strong>
            <span class="notice-actions">
              <Button variant="secondary" size="sm" onClick={() => (comparingDisk = false)}>Back to editing</Button>
              <Button variant="secondary" size="sm" onClick={reloadDiskSnapshot}>Use disk version</Button>
            </span>
          </header>
          <div class="comparison-panes">
            <section>
              <span>Your changes</span>
              <div class="comparison-editor">
                <CodeEditor
                  content={buffer}
                  languageHint={snapshot.language_hint}
                  readOnly
                  onChange={() => undefined}
                  onSave={() => undefined}
                />
              </div>
            </section>
            <section>
              <span>On disk</span>
              <div class="comparison-editor">
                {#key diskSnapshot.content_revision}
                  <CodeEditor
                    content={diskSnapshot.content}
                    languageHint={diskSnapshot.language_hint}
                    readOnly
                    onChange={() => undefined}
                    onSave={() => undefined}
                  />
                {/key}
              </div>
            </section>
          </div>
        </div>
      {:else if loading}
        <div class="editor-empty"><Text tone="muted">Loading file…</Text></div>
      {:else if snapshot}
        {#key snapshot.file_ref + snapshot.content_revision}
          <CodeEditor
            content={buffer}
            languageHint={snapshot.language_hint}
            readOnly={!snapshot.writable}
            onChange={handleBufferChange}
            onSave={() => void save()}
          />
          {#if !isSupportedEditorLanguage(snapshot.language_hint)}
            <span class="plain-text-note">Plain text</span>
          {/if}
        {/key}
      {:else}
        <div class="editor-empty">
          <Text tone="muted">Select a project file to begin.</Text>
        </div>
      {/if}
    </div>
    </div>
  </Surface>
</div>

<style>
  .editor-surface { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; container-name: editor-panel; container-type: inline-size; }
  .editor-surface :global(.poodle-surface) { width: 100%; height: 100%; min-height: 0; overflow: hidden; }
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
  .disk-status { padding: 0; color: var(--poodle-color-status-warning); font: inherit; font-size: 0.68rem; border: 0; background: transparent; cursor: pointer; }
  .disk-status:hover { text-decoration: underline; }
  .dirty { width: 0.42rem; height: 0.42rem; border-radius: 50%; background: currentColor; opacity: 0.7; }
  .spacer { flex: 1; }
  .editor-toolbar-icon { display: grid; place-items: center; flex: 0 0 auto; width: 1.75rem; height: 1.75rem; padding: 0; color: var(--poodle-color-text-secondary); border: 0; border-radius: var(--poodle-radius-control); background: transparent; cursor: pointer; }
  .editor-toolbar-icon:hover:not(:disabled) { color: var(--poodle-color-text-primary); background: var(--poodle-color-background-surface); }
  .editor-toolbar-icon:disabled { opacity: var(--poodle-state-opacity-disabled); cursor: default; }
  .editor-notice { padding: 0.45rem 0.65rem; border-bottom: 1px solid var(--poodle-color-border-subtle); }
  .editor-decision { display: flex; gap: 0.6rem; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .notice-actions { display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap; }
  .editor-body { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  .editor-comparison { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; min-height: 0; }
  .editor-comparison > header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; min-width: 0; padding: 0.4rem 0.55rem; border-bottom: 1px solid var(--poodle-color-border-subtle); }
  .editor-comparison > header strong { overflow: hidden; color: var(--poodle-color-text-secondary); font-size: 0.75rem; text-overflow: ellipsis; white-space: nowrap; }
  .comparison-panes { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); min-height: 0; }
  .comparison-panes > section { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; }
  .comparison-panes > section + section { border-left: 1px solid var(--poodle-color-border-subtle); }
  .comparison-panes > section > span { padding: 0.35rem 0.55rem; color: var(--poodle-color-text-muted); font-size: 0.68rem; border-bottom: 1px solid var(--poodle-color-border-subtle); }
  .comparison-editor { min-height: 0; overflow: hidden; }
  .plain-text-note { position: absolute; right: 0.7rem; bottom: 0.55rem; pointer-events: none; }
  .editor-empty { height: 100%; display: grid; place-items: center; }

  @container editor-panel (max-width: 38rem) {
    .editor-toolbar :global(.poodle-popover) { max-width: 55%; }
    .status { display: none; }
    .comparison-panes { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
    .comparison-panes > section + section { border-top: 1px solid var(--poodle-color-border-subtle); border-left: 0; }
  }
</style>
