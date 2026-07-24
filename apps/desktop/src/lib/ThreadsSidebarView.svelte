<script lang="ts">
  import { Icon, Text } from "@poodle/svelte";
  import { messageCircle, plus, refreshCw } from "@poodle/icons-lucide";
  import { onMount } from "svelte";
  import {
    buildControlCommandEnvelope,
    buildStateListQuery,
    projectRecordsFromResponse,
    submitControlEnvelope,
    type ControlProjectRecordDto,
  } from "./control";
  import {
    listAgentChatThreads,
    type AgentChatThreadSummary,
  } from "./control/agentChat";

  let {
    selectedProjectId = $bindable(null),
  }: {
    selectedProjectId: string | null;
  } = $props();

  let projects = $state<ControlProjectRecordDto[]>([]);
  let threads = $state<AgentChatThreadSummary[]>([]);
  let loading = $state(false);
  let creating = $state(false);
  let failure = $state<string | null>(null);
  let selectedConversationId = $state<string | null>(null);
  let namingChatId = $state<string | null>(null);
  let chatName = $state("");

  const transientChats = $derived(
    projects.filter((project) => project.status === "active" && project.retention === "transient"),
  );
  const emptyTransientChats = $derived(
    transientChats.filter((chat) =>
      !threads.some((thread) => thread.project_id === chat.project_id)
    ),
  );
  const threadCount = $derived(emptyTransientChats.length + threads.length);

  onMount(() => {
    void loadThreads();
  });

  async function loadThreads(): Promise<void> {
    loading = true;
    failure = null;
    try {
      const [projectsResponse, loadedThreads] = await Promise.all([
        submitControlEnvelope(buildStateListQuery("projects")),
        listAgentChatThreads(),
      ]);
      projects = projectRecordsFromResponse(projectsResponse);
      threads = loadedThreads;
    } catch (caught) {
      failure = formatError(caught);
    } finally {
      loading = false;
    }
  }

  async function newChat(): Promise<void> {
    if (creating) return;
    const previousIds = new Set(projects.map((project) => project.project_id));
    const idempotencyKey = `chat-create:${crypto.randomUUID()}`;
    creating = true;
    failure = null;
    try {
      await submitProjectCommand({
        kind: "project_create",
        command_id: `command:${idempotencyKey}`,
        display_name: "",
        transient: true,
        actor_ref: "operator:desktop",
        authority_host_ref: "host:embedded-desktop",
        idempotency_key: idempotencyKey,
      });
      await loadThreads();
      const created = projects.find((project) => !previousIds.has(project.project_id));
      if (created) selectedProjectId = created.project_id;
      notifyProjectsChanged();
    } catch (caught) {
      failure = formatError(caught);
    } finally {
      creating = false;
    }
  }

  async function keepChat(
    project: ControlProjectRecordDto,
    displayName: string | null = null,
  ): Promise<void> {
    if (creating) return;
    const idempotencyKey = `project-promote:${crypto.randomUUID()}`;
    creating = true;
    failure = null;
    try {
      await submitProjectCommand({
        kind: "project_lifecycle",
        command_id: `command:${idempotencyKey}`,
        project_id: project.project_id,
        action: "promote",
        expected_revision: project.revision_id,
        display_name: displayName,
        actor_ref: "operator:desktop",
        authority_host_ref: project.authority_host_ref,
        idempotency_key: idempotencyKey,
      });
      namingChatId = null;
      chatName = "";
      await loadThreads();
      notifyProjectsChanged();
    } catch (caught) {
      failure = formatError(caught);
    } finally {
      creating = false;
    }
  }

  async function submitProjectCommand(
    command: Parameters<typeof buildControlCommandEnvelope>[0],
  ): Promise<void> {
    const response = await submitControlEnvelope(buildControlCommandEnvelope(command));
    if (response.body.type !== "command_receipt") {
      throw new Error("Project command returned an unexpected response.");
    }
    if (response.body.status !== "accepted_for_state_mutation") {
      throw new Error(response.body.error_reason ?? "Project command was refused.");
    }
  }

  function projectName(projectId: string): string {
    return projects.find((project) => project.project_id === projectId)?.display_name ?? projectId;
  }

  function openThread(thread: AgentChatThreadSummary): void {
    selectedConversationId = thread.conversation_id;
    selectedProjectId = thread.project_id;
    window.dispatchEvent(
      new CustomEvent("nucleus:open-agent-chat-thread", {
        detail: {
          projectId: thread.project_id,
          conversationId: thread.conversation_id,
        },
      }),
    );
  }

  function notifyProjectsChanged(): void {
    window.dispatchEvent(new CustomEvent("nucleus:projects-changed"));
  }

  function formatError(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }
</script>

<section class="sidebar-view" aria-label="Threads">
  <header class="sidebar-view-head">
    <div>
      <h2>Threads</h2>
      <Text tone="muted">{loading ? "Loading" : `${threadCount} active`}</Text>
    </div>
    <div class="sidebar-view-actions">
      <button type="button" aria-label="New chat" title="New chat" disabled={creating} onclick={() => void newChat()}>
        <Icon icon={plus} size="sm" />
      </button>
      <button type="button" aria-label="Refresh threads" title="Refresh threads" disabled={loading} onclick={() => void loadThreads()}>
        <Icon icon={refreshCw} size="sm" />
      </button>
    </div>
  </header>

  {#if failure}
    <div class="sidebar-message"><Text tone="danger">{failure}</Text></div>
  {:else if !loading && threadCount === 0}
    <div class="sidebar-message"><Text tone="muted">No active threads.</Text></div>
  {:else}
    <div class="thread-list">
      {#each emptyTransientChats as chat (chat.project_id)}
        <section class="thread-row" class:active={chat.project_id === selectedProjectId}>
          <button class="thread-select" type="button" onclick={() => (selectedProjectId = chat.project_id)}>
            <Icon icon={messageCircle} size="sm" />
            <span>
              <strong>{chat.display_name}</strong>
              <small>Quick chat</small>
            </span>
          </button>
          <div class="thread-actions">
            <button type="button" disabled={creating} onclick={() => void keepChat(chat)}>Keep</button>
            <button type="button" disabled={creating} onclick={() => { namingChatId = chat.project_id; chatName = ""; }}>Name</button>
          </div>
          {#if namingChatId === chat.project_id}
            <form onsubmit={(event) => { event.preventDefault(); void keepChat(chat, chatName.trim()); }}>
              <input bind:value={chatName} aria-label="Project name" placeholder="Project name" />
              <button type="submit" disabled={!chatName.trim() || creating}>Keep</button>
              <button type="button" onclick={() => (namingChatId = null)}>Cancel</button>
            </form>
          {/if}
        </section>
      {/each}

      {#each threads as thread (thread.conversation_id)}
        <button
          class="work-thread-row"
          type="button"
          class:active={thread.conversation_id === selectedConversationId}
          onclick={() => openThread(thread)}
        >
          <Icon icon={messageCircle} size="sm" />
          <span>
            <strong>{thread.title}</strong>
            <small>{projectName(thread.project_id)} · {thread.status} · {thread.model}</small>
          </span>
        </button>
      {/each}
    </div>
  {/if}
</section>

<style>
  .sidebar-view {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    height: 100%;
    min-width: 0;
    min-height: 0;
    padding: 0.75rem;
    overflow: hidden;
  }

  .sidebar-view-head,
  .sidebar-view-actions,
  .thread-select,
  .thread-actions,
  .work-thread-row {
    display: flex;
    align-items: center;
  }

  .sidebar-view-head {
    justify-content: space-between;
    gap: 0.75rem;
  }

  .sidebar-view-head h2 {
    margin: 0;
    color: var(--poodle-color-text-secondary);
    font-size: 0.8125rem;
  }

  .sidebar-view-actions,
  .thread-actions {
    gap: 0.25rem;
  }

  .sidebar-view-actions button,
  .thread-actions button,
  form button {
    min-height: 1.75rem;
    color: var(--poodle-color-text-secondary);
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
  }

  .sidebar-view-actions button {
    display: grid;
    place-items: center;
    width: 1.75rem;
    padding: 0;
  }

  .thread-list {
    display: grid;
    align-content: start;
    gap: 0.25rem;
    min-height: 0;
    overflow: auto;
  }

  .thread-row {
    display: grid;
    gap: 0.375rem;
    padding: 0.375rem;
    border-radius: var(--poodle-radius-control);
  }

  .thread-row.active,
  .work-thread-row.active {
    background: var(--poodle-color-background-selected);
  }

  .thread-select,
  .work-thread-row {
    gap: 0.5rem;
    min-width: 0;
    color: var(--poodle-color-text-tertiary);
    text-align: left;
    border: 0;
    background: transparent;
  }

  .thread-select {
    padding: 0;
  }

  .work-thread-row {
    width: 100%;
    padding: 0.5rem;
    border-radius: var(--poodle-radius-control);
  }

  .thread-select:hover,
  .work-thread-row:hover {
    color: var(--poodle-color-text-secondary);
  }

  .thread-row.active .thread-select,
  .work-thread-row.active {
    color: var(--poodle-color-text-primary);
  }

  .thread-select span,
  .work-thread-row span {
    display: grid;
    min-width: 0;
  }

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 0.8125rem;
  }

  small {
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
  }

  .thread-row.active small,
  .work-thread-row.active small {
    color: var(--poodle-color-text-secondary);
  }

  form {
    display: flex;
    gap: 0.25rem;
  }

  form input {
    min-width: 0;
    flex: 1;
  }

  .sidebar-message {
    padding: 0.75rem 0;
  }
</style>
