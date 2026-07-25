<script lang="ts">
  import { EditableLabel, Icon, Text } from "@poodle/svelte";
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
    renameAgentChatThread,
    type AgentChatThreadSummary,
  } from "./control/agentChat";

  let {
    selectedProjectId = $bindable(null),
    selectedConversationId = $bindable(null),
  }: {
    selectedProjectId: string | null;
    selectedConversationId: string | null;
  } = $props();

  let projects = $state<ControlProjectRecordDto[]>([]);
  let threads = $state<AgentChatThreadSummary[]>([]);
  let loading = $state(false);
  let creating = $state(false);
  let failure = $state<string | null>(null);
  let projectNameDrafts = $state<Record<string, string>>({});
  let threadTitleDrafts = $state<Record<string, string>>({});
  let renamingConversationId = $state<string | null>(null);

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
      if (created) {
        selectedConversationId = null;
        selectedProjectId = created.project_id;
      }
      notifyProjectsChanged();
    } catch (caught) {
      failure = formatError(caught);
    } finally {
      creating = false;
    }
  }

  async function convertChat(
    project: ControlProjectRecordDto,
    fallbackName: string,
  ): Promise<void> {
    if (creating) return;
    const displayName = projectNameDrafts[project.project_id]?.trim()
      || fallbackName.trim()
      || null;
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
      delete projectNameDrafts[project.project_id];
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

  function transientProject(projectId: string): ControlProjectRecordDto | null {
    return transientChats.find((project) => project.project_id === projectId) ?? null;
  }

  function setProjectNameDraft(projectId: string, value: string): void {
    const displayName = value.trim();
    if (displayName) {
      projectNameDrafts[projectId] = displayName;
    } else {
      delete projectNameDrafts[projectId];
    }
  }

  async function commitThreadTitle(
    thread: AgentChatThreadSummary,
    value: string,
  ): Promise<void> {
    const title = value.trim();
    if (!title || title === thread.title || renamingConversationId) {
      delete threadTitleDrafts[thread.conversation_id];
      return;
    }

    threadTitleDrafts[thread.conversation_id] = title;
    renamingConversationId = thread.conversation_id;
    failure = null;
    try {
      await renameAgentChatThread(thread.project_id, thread.conversation_id, title);
      threads = threads.map((candidate) =>
        candidate.conversation_id === thread.conversation_id
          ? { ...candidate, title }
          : candidate
      );
      delete threadTitleDrafts[thread.conversation_id];
      window.dispatchEvent(new CustomEvent("nucleus:threads-changed"));
    } catch (caught) {
      delete threadTitleDrafts[thread.conversation_id];
      failure = formatError(caught);
    } finally {
      renamingConversationId = null;
    }
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

  function selectEmptyChat(projectId: string): void {
    selectedConversationId = null;
    selectedProjectId = projectId;
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
    <span class="sidebar-dimmed">{loading ? "Loading" : `${threadCount} active`}</span>
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
    <div class="sidebar-message"><span class="sidebar-dimmed">No active threads.</span></div>
  {:else}
    <div class="thread-list">
      {#each emptyTransientChats as chat (chat.project_id)}
        <section class="thread-row" class:active={chat.project_id === selectedProjectId}>
          <div class="thread-select">
            <button
              class="thread-open"
              type="button"
              aria-label="Open chat"
              onclick={() => selectEmptyChat(chat.project_id)}
            >
              <Icon icon={messageCircle} size="sm" />
            </button>
            <span>
              <EditableLabel
                value={projectNameDrafts[chat.project_id] ?? chat.display_name}
                ariaLabel="Chat name"
                activationMode="doubleClick"
                variant="flush"
                placeholder="Chat name"
                maxLength={80}
                showEditIcon
                disabled={creating}
                onCommit={({ value }) => setProjectNameDraft(chat.project_id, value.trim())}
              />
              <button class="thread-summary" type="button" onclick={() => selectEmptyChat(chat.project_id)}>
                <small>Quick chat</small>
              </button>
            </span>
          </div>
          <div class="thread-actions">
            <button type="button" disabled={creating} onclick={() => void convertChat(chat, chat.display_name)}>Convert to project</button>
          </div>
        </section>
      {/each}

      {#each threads as thread (thread.conversation_id)}
        {@const transientChat = transientProject(thread.project_id)}
        <section
          class="work-thread"
          class:transient={transientChat !== null}
          class:active={thread.conversation_id === selectedConversationId}
        >
          <div class="work-thread-row">
            <button
              class="thread-open"
              type="button"
              aria-label="Open chat"
              aria-current={thread.conversation_id === selectedConversationId ? "true" : undefined}
              onclick={() => openThread(thread)}
            >
              <Icon icon={messageCircle} size="sm" />
            </button>
            <span>
              <EditableLabel
                value={threadTitleDrafts[thread.conversation_id] ?? thread.title}
                ariaLabel="Thread name"
                activationMode="doubleClick"
                variant="flush"
                placeholder="Thread name"
                maxLength={80}
                showEditIcon
                disabled={creating || renamingConversationId === thread.conversation_id}
                onCommit={({ value }) => void commitThreadTitle(thread, value)}
              />
              <button class="thread-summary" type="button" onclick={() => openThread(thread)}>
                <small>{transientChat ? "" : `${projectName(thread.project_id)} · `}{thread.status} · {thread.model}</small>
              </button>
            </span>
          </div>
          {#if transientChat}
            <div class="thread-actions">
              <button
                type="button"
                disabled={creating || renamingConversationId === thread.conversation_id}
                onclick={() => void convertChat(
                  transientChat,
                  threadTitleDrafts[thread.conversation_id] ?? thread.title,
                )}
              >
                Convert to project
              </button>
            </div>
          {/if}
        </section>
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

  .sidebar-dimmed {
    color: var(--poodle-color-text-secondary);
    opacity: var(--poodle-state-opacity-muted);
  }

  .sidebar-view-actions,
  .thread-actions {
    gap: 0.25rem;
  }

  .thread-actions {
    min-width: 0;
    justify-content: flex-start;
  }

  .thread-actions > button {
    flex: none;
  }

  .sidebar-view-actions button,
  .thread-actions button {
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

  .work-thread {
    display: grid;
    min-width: 0;
    border-radius: var(--poodle-radius-control);
  }

  .work-thread.transient {
    gap: 0.375rem;
    padding: 0.375rem;
  }

  .thread-row.active,
  .work-thread.active {
    background: var(--poodle-color-background-selected);
  }

  .thread-select,
  .work-thread-row {
    gap: 0.5rem;
    min-width: 0;
    color: var(--poodle-color-text-secondary);
    text-align: left;
    border: 0;
    background: transparent;
    opacity: var(--poodle-state-opacity-muted);
  }

  .thread-select {
    padding: 0;
  }

  .work-thread-row {
    width: 100%;
    padding: 0.5rem;
    border-radius: var(--poodle-radius-control);
  }

  .work-thread.transient .work-thread-row {
    padding: 0.125rem;
  }

  .thread-select:hover,
  .work-thread-row:hover {
    color: var(--poodle-color-text-secondary);
    opacity: 1;
  }

  .thread-row.active .thread-select,
  .work-thread.active .work-thread-row {
    color: var(--poodle-color-text-primary);
    opacity: 1;
  }

  .thread-select span,
  .work-thread-row span {
    display: grid;
    min-width: 0;
  }

  .thread-open,
  .thread-summary {
    min-width: 0;
    padding: 0;
    color: inherit;
    text-align: left;
    border: 0;
    background: transparent;
  }

  .thread-open {
    display: flex;
    flex: none;
  }

  .thread-summary small {
    display: block;
  }

  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    color: var(--poodle-color-text-secondary);
    font-size: 0.6875rem;
  }

  .thread-row.active small,
  .work-thread.active small {
    color: var(--poodle-color-text-secondary);
  }

  .sidebar-message {
    padding: 0.75rem 0;
  }
</style>
