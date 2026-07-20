<script lang="ts">
  import { Icon, Select, Text } from "@poodle/svelte";
  import { arrowLeft, triangleAlert } from "@poodle/icons-lucide";
  import {
    buildControlCommandEnvelope,
    submitControlEnvelope,
    type ControlProjectRecordDto,
  } from "./control";

  type SyncPolicy = "manual" | "assisted" | "automatic" | "reviewed";

  let {
    project,
    onBack,
    onChanged,
    onManageResources,
  }: {
    project: ControlProjectRecordDto;
    onBack: () => void;
    onChanged: () => Promise<void>;
    onManageResources: () => void;
  } = $props();

  let editing = $state(false);
  let selectedResourceId = $state<string | null>(null);
  let syncPolicy = $state<SyncPolicy>("manual");
  let mutating = $state(false);
  let pendingDisable = $state(false);
  let failure = $state<string | null>(null);

  const gitResources = $derived(
    project.resources.filter((resource) => resource.kind === "git_repository"),
  );
  const resourceOptions = $derived(
    gitResources.map((resource) => ({
      value: resource.resource_id,
      label: resource.display_name,
      disabled: resource.location_status !== "present",
    })),
  );
  const policyOptions = [
    { value: "manual", label: "Manual" },
    { value: "assisted", label: "Assisted" },
    { value: "automatic", label: "Automatic" },
    { value: "reviewed", label: "Reviewed" },
  ];
  const configuredResource = $derived(
    gitResources.find((resource) => resource.resource_id === project.management_resource_id) ?? null,
  );

  function beginEditing() {
    selectedResourceId = project.management_resource_id ?? gitResources[0]?.resource_id ?? null;
    syncPolicy = isSyncPolicy(project.management_sync_policy)
      ? project.management_sync_policy
      : "manual";
    pendingDisable = false;
    failure = null;
    editing = true;
  }

  async function save() {
    if (!selectedResourceId || mutating) return;
    await mutate("set_management_projection", selectedResourceId, syncPolicy);
    if (!failure) editing = false;
  }

  async function disable() {
    if (mutating) return;
    await mutate("clear_management_projection", null, null);
    if (!failure) {
      pendingDisable = false;
      editing = false;
    }
  }

  async function mutate(
    action: "set_management_projection" | "clear_management_projection",
    resourceId: string | null,
    policy: SyncPolicy | null,
  ) {
    const idempotencyKey = `project-shared-files-${action}:${crypto.randomUUID()}`;
    mutating = true;
    failure = null;
    try {
      const response = await submitControlEnvelope(
        buildControlCommandEnvelope({
          kind: "project_resource",
          command_id: `command:${idempotencyKey}`,
          project_id: project.project_id,
          action,
          expected_revision: project.revision_id,
          resource_id: resourceId,
          locator: null,
          display_name: null,
          role: null,
          set_as_default: null,
          sync_policy: policy,
          actor_ref: "operator:desktop",
          authority_host_ref: project.authority_host_ref,
          idempotency_key: idempotencyKey,
        }),
      );
      if (response.body.type !== "command_receipt") {
        throw new Error("Shared project files command returned an unexpected response.");
      }
      if (response.body.status !== "accepted_for_state_mutation") {
        throw new Error(response.body.error_reason ?? "Shared project files command was refused.");
      }
      await onChanged();
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    } finally {
      mutating = false;
    }
  }

  function isSyncPolicy(value: string | null): value is SyncPolicy {
    return value === "manual" || value === "assisted" || value === "automatic" || value === "reviewed";
  }

  function statusLabel(value: string | null): string {
    return (value ?? "unknown").replaceAll("_", " ");
  }
</script>

<section class="shared-files-manager">
  <header class="shared-files-head">
    <button class="back-button" type="button" aria-label="Back to projects" onclick={onBack}>
      <Icon icon={arrowLeft} size="sm" />
    </button>
    <span class="shared-files-title">
      <strong>{project.display_name}</strong>
      <small>Optional Git-backed project projection</small>
    </span>
  </header>

  {#if failure}
    <div class="message"><Text tone="danger">{failure}</Text></div>
  {/if}

  <div class="authority-note">
    <Text tone="muted">Nucleus remains the active source of truth. This repository carries the optional shared projection.</Text>
  </div>

  {#if project.management_resource_id && !editing}
    <section class="configured-projection">
      <div class="configured-row">
        <span class="configured-copy">
          <strong>{configuredResource?.display_name ?? "Unavailable Git resource"}</strong>
          <small>{project.management_sync_policy ?? "Unknown policy"} · {statusLabel(project.management_projection_status)}</small>
        </span>
        <span
          class:status-warning={project.management_projection_status !== "ready"}
          class="status"
        >{statusLabel(project.management_projection_status)}</span>
      </div>
      {#if project.management_projection_status !== "ready"}
        <div class="repair-notice">
          <Icon icon={triangleAlert} size="xs" />
          <span>The selected repository needs resource repair before files can sync.</span>
          <button type="button" onclick={onManageResources}>Manage resources</button>
        </div>
      {/if}
      <div class="actions">
        <button type="button" onclick={beginEditing}>Change</button>
        <button class="danger-action" type="button" onclick={() => (pendingDisable = true)}>Disable</button>
      </div>
      {#if pendingDisable}
        <div class="confirmation">
          <span>Stop projecting shared project files? Active project state is retained.</span>
          <button class="danger-action" type="button" disabled={mutating} onclick={() => void disable()}>Disable</button>
          <button type="button" disabled={mutating} onclick={() => (pendingDisable = false)}>Cancel</button>
        </div>
      {/if}
    </section>
  {:else if editing}
    <section class="configuration-form">
      <label>
        <span>Git resource</span>
        <Select
          value={selectedResourceId}
          options={resourceOptions}
          variant="default"
          size="sm"
          native={false}
          menuMinWidth="15rem"
          ariaLabel="Shared project files Git resource"
          disabled={mutating}
          onValueChange={(value) => (selectedResourceId = value)}
        />
      </label>
      <label>
        <span>Sync policy</span>
        <Select
          value={syncPolicy}
          options={policyOptions}
          variant="default"
          size="sm"
          native={false}
          menuMinWidth="12rem"
          ariaLabel="Shared project files sync policy"
          disabled={mutating}
          onValueChange={(value) => (syncPolicy = value as SyncPolicy)}
        />
      </label>
      <div class="actions">
        <button type="button" disabled={!selectedResourceId || mutating} onclick={() => void save()}>Save</button>
        <button type="button" disabled={mutating} onclick={() => (editing = false)}>Cancel</button>
      </div>
    </section>
  {:else}
    <section class="empty-projection">
      <Text tone="muted">Shared project files are off. Nucleus remains the active source of truth.</Text>
      {#if gitResources.length > 0}
        <button type="button" onclick={beginEditing}>Configure</button>
      {:else}
        <button type="button" onclick={onManageResources}>Attach a Git resource</button>
      {/if}
    </section>
  {/if}
</section>

<style>
  .shared-files-manager,
  .configured-projection,
  .configuration-form,
  .empty-projection {
    display: grid;
    gap: 0.75rem;
  }

  .shared-files-head,
  .configured-row,
  .repair-notice,
  .actions,
  .confirmation {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .back-button {
    display: inline-grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    flex: 0 0 auto;
    padding: 0;
    color: var(--poodle-color-text-secondary);
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
  }

  .back-button:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
  }

  .shared-files-title,
  .configured-copy {
    display: grid;
    min-width: 0;
    flex: 1;
  }

  .shared-files-title strong,
  .configured-copy strong {
    color: var(--poodle-color-text-primary);
    font-size: 0.8125rem;
  }

  .shared-files-title small,
  .configured-copy small,
  .configuration-form label > span {
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    text-transform: capitalize;
  }

  .configured-projection,
  .configuration-form,
  .empty-projection {
    padding: 0.75rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
  }

  .configuration-form label {
    display: grid;
    gap: 0.375rem;
  }

  .status {
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    text-transform: capitalize;
  }

  .status-warning,
  .repair-notice {
    color: var(--poodle-color-text-warning, #d9a441);
  }

  .repair-notice,
  .confirmation {
    flex-wrap: wrap;
    font-size: 0.75rem;
  }

  .repair-notice span,
  .confirmation span {
    flex: 1;
  }

  button {
    min-height: 1.75rem;
    padding: 0.25rem 0.5rem;
    color: var(--poodle-color-text-secondary);
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-elevated);
  }

  button:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .danger-action {
    color: var(--poodle-color-text-danger);
  }

  .message {
    padding: 0 0.25rem;
  }

  .authority-note {
    font-size: 0.75rem;
  }
</style>
