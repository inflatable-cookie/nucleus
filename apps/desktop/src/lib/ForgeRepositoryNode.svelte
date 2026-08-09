<script lang="ts">
  import { Icon } from "@inflatable-cookie/poodle-svelte";
  import { chevronDown, chevronRight, gitBranch, gitFork } from "../icons.generated";
  import type {
    ControlProjectResourceRecordDto,
    ScmWorkingCopyDiffScope,
    ScmWorkingCopyFileStatus,
    ScmWorkingCopyInspection,
    ScmWorkingCopyMutationAction,
  } from "./control";
  import ForgeChangeGroup from "./ForgeChangeGroup.svelte";
  import ForgeCommitComposer from "./ForgeCommitComposer.svelte";

  let {
    repository,
    inspection,
    expanded,
    mutationKey,
    commitBusy,
    commitMessage,
    notice,
    onToggle,
    onOpen,
    onMutate,
    onCommitMessageChange,
    onCommit,
  }: {
    repository: ControlProjectResourceRecordDto;
    inspection: ScmWorkingCopyInspection | undefined;
    expanded: boolean;
    mutationKey: string | null;
    commitBusy: boolean;
    commitMessage: string;
    notice: string;
    onToggle: () => void;
    onOpen: (
      file: ScmWorkingCopyFileStatus,
      scope: Exclude<ScmWorkingCopyDiffScope, "all">,
    ) => void;
    onMutate: (paths: string[], action: ScmWorkingCopyMutationAction) => void;
    onCommitMessageChange: (message: string) => void;
    onCommit: () => void;
  } = $props();

  const stagedFiles = $derived(
    inspection?.state === "ready" ? inspection.files.filter((file) => file.staged) : [],
  );
  const workingFiles = $derived(
    inspection?.state === "ready" ? inspection.files.filter((file) => file.unstaged) : [],
  );
</script>

<section class="repository-node">
  <button
    class="repository-row"
    type="button"
    aria-expanded={expanded}
    onclick={onToggle}
  >
    <Icon icon={expanded ? chevronDown : chevronRight} size="xs" />
    <Icon icon={gitFork} size="sm" />
    <span class="repository-identity">
      <strong>{repository.display_name}</strong>
      <small>
        {inspection?.state === "ready"
          ? (inspection.branch ?? "detached HEAD")
          : repository.location_status}
      </small>
    </span>
    {#if inspection?.state === "ready"}
      <span class:dirty={inspection.files.length > 0} class="repository-status">
        {inspection.files.length > 0 ? inspection.files.length : "Clean"}
      </span>
    {:else if inspection?.state === "unavailable"}
      <span class="repository-status unavailable" title={inspection.error ?? "Unavailable"}>!</span>
    {:else if repository.default_branch}
      <span class="branch-hint" title="Recorded default branch">
        <Icon icon={gitBranch} size="xs" />
        {repository.default_branch}
      </span>
    {/if}
  </button>

  {#if expanded}
    <div class="changed-files">
      {#if notice}<span class="repository-notice">{notice}</span>{/if}
      {#if inspection?.state === "ready" && inspection.files.length === 0}
        <span class="repository-message">Working copy clean.</span>
      {:else if inspection?.state === "ready"}
        {#if stagedFiles.length > 0}
          <ForgeChangeGroup
            label="Staged"
            scope="staged"
            files={stagedFiles}
            {mutationKey}
            {onOpen}
            onMutate={(file, action) => onMutate([file.path], action)}
            onMutateAll={(action) => onMutate(stagedFiles.map((file) => file.path), action)}
          />
        {/if}
        {#if workingFiles.length > 0}
          <ForgeChangeGroup
            label="Working"
            scope="working"
            files={workingFiles}
            {mutationKey}
            {onOpen}
            onMutate={(file, action) => onMutate([file.path], action)}
            onMutateAll={(action) => onMutate(workingFiles.map((file) => file.path), action)}
          />
        {/if}
        {#if stagedFiles.length > 0}
          <ForgeCommitComposer
            message={commitMessage}
            busy={commitBusy}
            disabled={mutationKey !== null}
            result={notice || null}
            onMessageChange={onCommitMessageChange}
            {onCommit}
          />
        {/if}
      {:else}
        <span class="repository-message">
          {inspection?.error ?? "Repository status is unavailable."}
        </span>
      {/if}
    </div>
  {/if}
</section>

<style>
  .repository-node {
    display: grid;
    min-width: 0;
  }

  .repository-row,
  .branch-hint {
    display: flex;
    align-items: center;
  }

  .repository-row {
    gap: 0.375rem;
    min-width: 0;
    width: 100%;
    padding: 0.375rem;
    color: var(--poodle-color-text-secondary);
    text-align: left;
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
  }

  .repository-row:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
  }

  .repository-identity {
    display: grid;
    min-width: 0;
    flex: 1;
  }

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 0.75rem;
    font-weight: 500;
  }

  small,
  .repository-status,
  .repository-message {
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
  }

  .repository-status {
    flex: 0 0 auto;
  }

  .repository-status.dirty {
    color: var(--poodle-color-text-accent);
  }

  .repository-status.unavailable {
    color: var(--poodle-color-text-danger);
  }

  .branch-hint {
    gap: 0.25rem;
    max-width: 40%;
    overflow: hidden;
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .changed-files {
    display: grid;
    gap: 0.375rem;
    min-width: 0;
    margin-left: 1rem;
    padding-left: 0.5rem;
    border-left: 1px solid var(--poodle-color-border-subtle);
  }

  .repository-message,
  .repository-notice {
    padding: 0.5rem 0.375rem;
  }

  .repository-notice {
    color: var(--poodle-color-text-success);
    font-size: 0.6875rem;
  }
</style>
