<script lang="ts">
  import { Icon } from "@inflatable-cookie/poodle-svelte";
  import { fileDiff, minus, plus } from "@inflatable-cookie/poodle-icons-lucide";
  import type {
    ScmWorkingCopyDiffScope,
    ScmWorkingCopyFileStatus,
    ScmWorkingCopyMutationAction,
  } from "./control";

  let {
    label,
    scope,
    files,
    mutationKey,
    onOpen,
    onMutate,
    onMutateAll,
  }: {
    label: string;
    scope: Exclude<ScmWorkingCopyDiffScope, "all">;
    files: ScmWorkingCopyFileStatus[];
    mutationKey: string | null;
    onOpen: (file: ScmWorkingCopyFileStatus, scope: "staged" | "working") => void;
    onMutate: (
      file: ScmWorkingCopyFileStatus,
      action: ScmWorkingCopyMutationAction,
    ) => void;
    onMutateAll: (action: ScmWorkingCopyMutationAction) => void;
  } = $props();

  const action = $derived<ScmWorkingCopyMutationAction>(
    scope === "staged" ? "unstage" : "stage",
  );

  function changeMarker(file: ScmWorkingCopyFileStatus): string {
    switch (file.change_kind) {
      case "added": return "A";
      case "deleted": return "D";
      case "renamed": return "R";
      case "copied": return "C";
      case "untracked": return "?";
      case "conflicted": return "!";
      case "type_changed": return "T";
      case "modified": return "M";
      default: return "·";
    }
  }
</script>

<div class="change-group">
  <div class="change-group-head">
    <span class="change-group-label">{label} <small>{files.length}</small></span>
    <button
      class="change-group-action"
      type="button"
      aria-label={`${action === "stage" ? "Stage" : "Unstage"} all ${label.toLowerCase()} changes`}
      title={`${action === "stage" ? "Stage" : "Unstage"} all`}
      disabled={mutationKey !== null || files.some((file) => file.change_kind === "conflicted")}
      onclick={() => onMutateAll(action)}
    >
      <Icon icon={action === "stage" ? plus : minus} size="xs" />
    </button>
  </div>
  {#each files as file (`${scope}:${file.path}:${file.index_status}:${file.worktree_status}`)}
    <div class="changed-file-row">
      <button
        class="changed-file"
        type="button"
        title={`Review ${scope} changes for ${file.path}`}
        onclick={() => onOpen(file, scope)}
      >
        <span class:conflicted={file.change_kind === "conflicted"} class="change-marker">
          {changeMarker(file)}
        </span>
        <Icon icon={fileDiff} size="xs" />
        <span class="changed-file-identity"><strong>{file.path}</strong></span>
      </button>
      <button
        class="changed-file-action"
        type="button"
        aria-label={`${action === "stage" ? "Stage" : "Unstage"} ${file.path}`}
        title={`${action === "stage" ? "Stage" : "Unstage"} ${file.path}`}
        disabled={mutationKey !== null || file.change_kind === "conflicted"}
        onclick={() => onMutate(file, action)}
      >
        <Icon icon={action === "stage" ? plus : minus} size="xs" />
      </button>
    </div>
  {/each}
</div>

<style>
  .change-group {
    display: grid;
    min-width: 0;
  }

  .change-group-head {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .change-group-label {
    padding: 0.25rem 0.375rem 0.125rem;
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .change-group-action {
    display: grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    margin-left: auto;
    margin-right: 0.15rem;
    padding: 0;
    color: var(--poodle-color-text-muted);
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
  }

  .change-group-action:hover:not(:disabled) {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-elevated);
  }

  .change-group-label small {
    margin-left: 0.2rem;
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    font-weight: 400;
  }

  .changed-file-row,
  .changed-file {
    display: flex;
    align-items: center;
  }

  .changed-file-row {
    min-width: 0;
    border-radius: var(--poodle-radius-control);
  }

  .changed-file-row:hover,
  .changed-file-row:focus-within {
    background: var(--poodle-color-background-surface);
  }

  .changed-file {
    gap: 0.375rem;
    min-width: 0;
    padding: 0.3rem 0.375rem;
    flex: 1;
    color: var(--poodle-color-text-secondary);
    text-align: left;
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
  }

  .changed-file:hover {
    color: var(--poodle-color-text-primary);
  }

  .changed-file-identity {
    display: grid;
    min-width: 0;
    flex: 1;
  }

  strong {
    overflow: hidden;
    font-size: 0.75rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .change-marker {
    width: 0.75rem;
    flex: 0 0 0.75rem;
    color: var(--poodle-color-text-accent);
    font-size: 0.6875rem;
    font-weight: 600;
    text-align: center;
  }

  .change-marker.conflicted {
    color: var(--poodle-color-text-danger);
  }

  .changed-file-action {
    display: grid;
    place-items: center;
    width: 1.6rem;
    height: 1.6rem;
    margin-right: 0.15rem;
    padding: 0;
    flex: 0 0 1.6rem;
    color: var(--poodle-color-text-muted);
    opacity: 0;
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
  }

  .changed-file-row:hover .changed-file-action,
  .changed-file-action:focus-visible {
    opacity: 1;
  }

  .changed-file-action:hover:not(:disabled) {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-elevated);
  }

  .changed-file-action:disabled {
    cursor: default;
  }
</style>
