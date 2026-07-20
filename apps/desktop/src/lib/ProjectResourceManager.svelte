<script lang="ts">
  import { Icon, Menu, Text, type MenuItem } from "@poodle/svelte";
  import { arrowLeft, ellipsis, folderPlus } from "@poodle/icons-lucide";
  import { open } from "@tauri-apps/plugin-dialog";
  import {
    buildControlCommandEnvelope,
    submitControlEnvelope,
    type ControlProjectRecordDto,
    type ControlProjectResourceRecordDto,
  } from "./control";
  import { closeTerminalProject } from "./terminalClient";

  let {
    project,
    onBack,
    onChanged,
  }: {
    project: ControlProjectRecordDto;
    onBack: () => void;
    onChanged: () => Promise<void>;
  } = $props();

  let mutatingResourceId = $state<string | null>(null);
  let pendingRemoveId = $state<string | null>(null);
  let failure = $state<string | null>(null);

  function resourceMenuItems(resource: ControlProjectResourceRecordDto): MenuItem[] {
    return [
      ...(resource.role === "working" && !resource.is_default_working_resource
        ? [{ value: "default", label: "Make default" } satisfies MenuItem]
        : []),
      {
        value: "locate",
        label: resource.location_status === "present" ? "Change location…" : "Locate…",
      },
      { value: "separator", label: "", kind: "separator" },
      { value: "remove", label: "Remove", tone: "danger" },
    ];
  }

  function handleResourceAction(resource: ControlProjectResourceRecordDto, action: string) {
    failure = null;
    pendingRemoveId = null;
    if (action === "default") {
      void updateDefault(resource);
    } else if (action === "locate") {
      void repairResource(resource);
    } else if (action === "remove") {
      pendingRemoveId = resource.resource_id;
    }
  }

  async function attachResource() {
    if (mutatingResourceId) return;
    const locator = await chooseDirectory("Open project folder or repository");
    if (!locator) return;
    await mutateResource("attach", null, locator, null, null);
  }

  async function repairResource(resource: ControlProjectResourceRecordDto) {
    if (mutatingResourceId) return;
    const locator = await chooseDirectory(`Locate ${resource.display_name}`);
    if (!locator) return;
    await mutateResource("repair", resource.resource_id, locator, null, null);
  }

  async function updateDefault(resource: ControlProjectResourceRecordDto) {
    await mutateResource("update", resource.resource_id, null, null, true);
  }

  async function removeResource(resource: ControlProjectResourceRecordDto) {
    await mutateResource("remove", resource.resource_id, null, null, null);
  }

  async function chooseDirectory(title: string): Promise<string | null> {
    try {
      const selected = await open({ directory: true, multiple: false, title });
      return typeof selected === "string" ? selected : null;
    } catch (caught) {
      failure = formatError(caught);
      return null;
    }
  }

  async function mutateResource(
    action: "attach" | "update" | "repair" | "remove",
    resourceId: string | null,
    locator: string | null,
    displayName: string | null,
    setAsDefault: boolean | null,
  ) {
    if (mutatingResourceId) return;
    const idempotencyKey = `project-resource-${action}:${crypto.randomUUID()}`;
    mutatingResourceId = resourceId ?? "attach";
    failure = null;
    try {
      await closeTerminalProject(project.project_id);
      const response = await submitControlEnvelope(
        buildControlCommandEnvelope({
          kind: "project_resource",
          command_id: `command:${idempotencyKey}`,
          project_id: project.project_id,
          action,
          expected_revision: project.revision_id,
          resource_id: resourceId,
          locator,
          display_name: displayName,
          role: null,
          set_as_default: setAsDefault,
          sync_policy: null,
          actor_ref: "operator:desktop",
          authority_host_ref: project.authority_host_ref,
          idempotency_key: idempotencyKey,
        }),
      );
      if (response.body.type !== "command_receipt") {
        throw new Error("Resource command returned an unexpected response.");
      }
      if (response.body.status !== "accepted_for_state_mutation") {
        throw new Error(response.body.error_reason ?? "Resource command was refused.");
      }
      pendingRemoveId = null;
      await onChanged();
    } catch (caught) {
      failure = formatError(caught);
    } finally {
      mutatingResourceId = null;
    }
  }

  function kindLabel(kind: ControlProjectResourceRecordDto["kind"]): string {
    return kind === "git_repository" ? "Git repository" : "Folder";
  }

  function healthLabel(status: ControlProjectResourceRecordDto["location_status"]): string {
    return status.replaceAll("_", " ");
  }

  function hostLabel(host: string): string {
    return host.replace(/^host:/, "");
  }

  function formatError(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }
</script>

<section class="resource-manager">
  <header class="resource-manager-head">
    <button class="back-button" type="button" aria-label="Back to projects" onclick={onBack}>
      <Icon icon={arrowLeft} size="sm" />
    </button>
    <span class="resource-manager-title">
      <strong>{project.display_name}</strong>
      <small>{project.resources.length} resource{project.resources.length === 1 ? "" : "s"}</small>
    </span>
    <button
      class="attach-button"
      type="button"
      disabled={mutatingResourceId !== null}
      onclick={() => void attachResource()}
    >
      <Icon icon={folderPlus} size="sm" />
      <span>Open folder…</span>
    </button>
  </header>

  {#if failure}
    <div class="resource-message"><Text tone="danger">{failure}</Text></div>
  {/if}

  <div class="resource-list">
    {#each project.resources as resource (resource.resource_id)}
      <section class="resource-row">
        <div class="resource-summary">
          <span class="resource-copy">
            <strong>{resource.display_name}</strong>
            <small>
              {kindLabel(resource.kind)} · {resource.role} · {hostLabel(resource.authority_host_ref)}
            </small>
          </span>
          <span class:resource-health--warning={resource.location_status !== "present"} class="resource-health">
            {healthLabel(resource.location_status)}
          </span>
          <Menu
            items={resourceMenuItems(resource)}
            ariaLabel={`Resource actions for ${resource.display_name}`}
            placement="bottom-end"
            onAction={(action) => handleResourceAction(resource, action)}
          >
            {#snippet trigger()}
              <button
                class="resource-menu-button"
                type="button"
                aria-label={`Resource actions for ${resource.display_name}`}
                disabled={mutatingResourceId !== null}
              >
                <Icon icon={ellipsis} size="sm" />
              </button>
            {/snippet}
          </Menu>
        </div>

        <details>
          <summary>Details</summary>
          <dl>
            <div><dt>Resource ID</dt><dd>{resource.resource_id}</dd></div>
            <div><dt>Authority host</dt><dd>{resource.authority_host_ref}</dd></div>
            <div><dt>Default branch</dt><dd>{resource.default_branch ?? "Not recorded"}</dd></div>
            <div><dt>Default target</dt><dd>{resource.is_default_working_resource ? "Yes" : "No"}</dd></div>
          </dl>
        </details>

        {#if pendingRemoveId === resource.resource_id}
          <div class="remove-confirmation">
            <span>Remove this membership? Files will not be changed.</span>
            <button class="danger-action" type="button" onclick={() => void removeResource(resource)}>Remove</button>
            <button type="button" onclick={() => (pendingRemoveId = null)}>Cancel</button>
          </div>
        {/if}
      </section>
    {:else}
      <div class="resource-empty">
        <Text tone="muted">No folders or repositories attached. Tasks and Terminal still work; file-backed actions need a resource.</Text>
      </div>
    {/each}
  </div>
</section>

<style>
  .resource-manager {
    display: grid;
    gap: 0.75rem;
  }

  .resource-manager-head,
  .resource-summary,
  .remove-confirmation {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .resource-manager-title,
  .resource-copy {
    display: grid;
    min-width: 0;
    flex: 1;
  }

  .resource-manager-title strong,
  .resource-copy strong {
    color: var(--poodle-color-text-primary);
    font-size: 0.8125rem;
  }

  .resource-manager-title small,
  .resource-copy small {
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    text-transform: capitalize;
  }

  .back-button,
  .resource-menu-button {
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

  .back-button:hover,
  .resource-menu-button:hover:not(:disabled) {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
  }

  .attach-button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 1.875rem;
    padding: 0.25rem 0.625rem;
    color: var(--poodle-color-text-primary);
    border: 1px solid var(--poodle-color-border-default);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
    cursor: pointer;
  }

  .resource-list {
    display: grid;
    gap: 0.25rem;
    max-height: min(24rem, 55vh);
    overflow: auto;
  }

  .resource-row {
    min-width: 0;
    padding: 0.5rem 0.25rem;
    border-bottom: 1px solid var(--poodle-color-border-subtle);
  }

  .resource-row:last-child {
    border-bottom: 0;
  }

  .resource-health {
    flex: 0 0 auto;
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    text-transform: capitalize;
  }

  .resource-health--warning {
    color: var(--poodle-color-text-warning, #d9a441);
  }

  details {
    margin: 0.375rem 0 0 0.25rem;
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
  }

  summary {
    width: max-content;
    cursor: pointer;
  }

  dl {
    display: grid;
    gap: 0.25rem;
    margin: 0.5rem 0 0;
  }

  dl div {
    display: grid;
    grid-template-columns: 6.5rem minmax(0, 1fr);
    gap: 0.5rem;
  }

  dt {
    color: var(--poodle-color-text-muted);
  }

  dd {
    min-width: 0;
    margin: 0;
    color: var(--poodle-color-text-secondary);
    overflow-wrap: anywhere;
  }

  .remove-confirmation {
    margin-top: 0.5rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .remove-confirmation span {
    flex: 1;
  }

  .remove-confirmation button {
    min-height: 1.625rem;
    padding: 0.2rem 0.45rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: transparent;
    color: var(--poodle-color-text-secondary);
    cursor: pointer;
  }

  .remove-confirmation .danger-action {
    color: var(--poodle-color-text-danger);
  }

  .resource-message,
  .resource-empty {
    padding: 0.5rem 0.25rem;
  }
</style>
