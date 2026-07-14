<script module lang="ts">
  import type { AgentChatModelOption } from "./control/agentChat";

  type ChatMessage = {
    id: string;
    role: "user" | "assistant";
    text: string;
    taskReceipts: import("./control/agentChat").TaskAuthoringReceipt[];
    workflowReceipts: import("./control/agentChat").TaskWorkflowReceipt[];
  };

  const retainedMessages = new Map<string, ChatMessage[]>();
  const retainedModels = new Map<string, string>();
  const retainedReasoningEfforts = new Map<string, string>();
  const retainedPendingConversations = new Set<string>();
  let retainedModelCatalog: AgentChatModelOption[] | null = null;
  let modelCatalogRequest: Promise<AgentChatModelOption[]> | null = null;

  const DEFAULT_MODEL = "gpt-5.4-mini";
  const DEFAULT_REASONING_EFFORT = "low";
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { Icon, Select, Text } from "@poodle/svelte";
  import { arrowUp, brain, chevronDown, messageSquareText, sparkles } from "@poodle/icons-lucide";
  import TaskCreationReceipt from "./TaskCreationReceipt.svelte";
  import TaskWorkflowReceipt from "./TaskWorkflowReceipt.svelte";
  import type { ControlGoalRecordDto, ControlTaskRecordDto } from "./control";
  import type { TaskAuthoringReceipt, TaskWorkflowReceipt as WorkflowReceipt } from "./control/agentChat";
  import { listAgentChatModels, loadAgentChatHistory, sendAgentChatMessage } from "./control/agentChat";

  let {
    conversationId,
    projectId,
    activeGoal,
    activeTask,
    onClearActiveGoal,
    onClearActiveTask,
  }: {
    conversationId: string;
    projectId: string | null;
    activeGoal: ControlGoalRecordDto | null;
    activeTask: ControlTaskRecordDto | null;
    onClearActiveGoal: () => void;
    onClearActiveTask: () => void;
  } = $props();

  let activeConversationId = $state("");
  let messages = $state<ChatMessage[]>([]);
  let draft = $state("");
  let pending = $state(false);
  let loadingHistory = $state(false);
  let failure = $state<string | null>(null);
  let model = $state(DEFAULT_MODEL);
  let reasoningEffort = $state(DEFAULT_REASONING_EFFORT);
  let modelCatalog = $state<AgentChatModelOption[]>(retainedModelCatalog ?? []);
  let composerInput = $state<HTMLTextAreaElement | null>(null);
  let timeline = $state<HTMLElement | null>(null);
  let hydrationVersion = 0;
  const modelOptions = $derived.by(() => {
    const options = modelCatalog.map((option) => ({
      value: option.model,
      label: option.display_name,
      icon: sparkles,
    }));
    if (!options.some((option) => option.value === model)) {
      options.unshift({ value: model, label: model, icon: sparkles });
    }
    return options;
  });
  const selectedModelOption = $derived(
    modelCatalog.find((option) => option.model === model) ?? null,
  );
  const reasoningOptions = $derived.by(() => {
    const options = selectedModelOption?.supported_reasoning_efforts.map((option) => ({
      value: option.reasoning_effort,
      label: reasoningLabel(option.reasoning_effort),
      icon: brain,
    })) ?? [];
    if (!options.some((option) => option.value === reasoningEffort)) {
      options.unshift({
        value: reasoningEffort,
        label: reasoningLabel(reasoningEffort),
        icon: brain,
      });
    }
    return options;
  });

  $effect(() => {
    if (activeConversationId !== conversationId) {
      activeConversationId = conversationId;
      messages = retainedMessages.get(conversationId) ?? [];
      pending = retainedPendingConversations.has(conversationId);
      model = retainedModels.get(conversationId) ?? DEFAULT_MODEL;
      reasoningEffort = retainedReasoningEfforts.get(conversationId) ?? DEFAULT_REASONING_EFFORT;
      void scrollToLatest();
      if (projectId) {
        void hydrateModelCatalog();
        void hydrateHistory(projectId, conversationId);
      }
    }
  });

  async function hydrateHistory(nextProjectId: string, nextConversationId: string): Promise<void> {
    const version = ++hydrationVersion;
    loadingHistory = true;
    failure = null;
    try {
      const history = await loadAgentChatHistory(nextProjectId, nextConversationId);
      if (version !== hydrationVersion || nextConversationId !== conversationId) {
        return;
      }
      messages = history.messages.map((message) => ({
        id: message.message_id,
        role: message.role,
        text: message.text,
        taskReceipts: message.task_receipts,
        workflowReceipts: message.workflow_receipts,
      }));
      retainedMessages.set(nextConversationId, messages);
      model = history.model ?? model;
      reasoningEffort = history.reasoning_effort ?? reasoningEffort;
      if (history.model) {
        retainedModels.set(nextConversationId, history.model);
      }
      if (history.reasoning_effort) {
        retainedReasoningEfforts.set(nextConversationId, history.reasoning_effort);
      }
      await scrollToLatest();
    } catch (caught) {
      if (version === hydrationVersion) {
        failure = caught instanceof Error ? caught.message : String(caught);
      }
    } finally {
      if (version === hydrationVersion) {
        loadingHistory = false;
        pending = retainedPendingConversations.has(nextConversationId);
        await scrollToLatest();
      }
    }
  }

  async function submit(): Promise<void> {
    const message = draft.trim();
    if (!projectId || !message || pending || loadingHistory) {
      return;
    }

    failure = null;
    pending = true;
    retainedPendingConversations.add(conversationId);
    draft = "";
    await tick();
    resizeComposer();
    const optimisticMessageId = `user:${crypto.randomUUID()}`;
    appendMessage({
      id: optimisticMessageId,
      role: "user",
      text: message,
      taskReceipts: [],
      workflowReceipts: [],
    });

    try {
      const reply = await sendAgentChatMessage({
        conversation_id: conversationId,
        project_id: projectId,
        message,
        active_goal_id: activeGoal?.goal_id ?? null,
        active_task_id: activeTask?.task_id ?? null,
        model,
        reasoning_effort: reasoningEffort,
      });
      model = reply.model;
      retainedModels.set(conversationId, reply.model);
      reasoningEffort = reply.reasoning_effort ?? reasoningEffort;
      if (reply.reasoning_effort) {
        retainedReasoningEfforts.set(conversationId, reply.reasoning_effort);
      }
      appendMessage({
        id: reply.turn_id,
        role: "assistant",
        text: reply.assistant_message,
        taskReceipts: reply.task_receipts,
        workflowReceipts: reply.workflow_receipts,
      });
      if (reply.task_receipts.length > 0 || reply.workflow_receipts.length > 0) {
        window.dispatchEvent(
          new CustomEvent("nucleus:tasks-changed", { detail: { projectId } }),
        );
      }
    } catch (caught) {
      messages = messages.filter((message) => message.id !== optimisticMessageId);
      retainedMessages.set(conversationId, messages);
      failure = caught instanceof Error ? caught.message : String(caught);
    } finally {
      retainedPendingConversations.delete(conversationId);
      pending = false;
      await scrollToLatest();
    }
  }

  function appendMessage(message: ChatMessage): void {
    messages = [...messages, message];
    retainedMessages.set(conversationId, messages);
    void scrollToLatest();
  }

  function openTaskReceipt(receipt: TaskAuthoringReceipt): void {
    if (!projectId) {
      return;
    }
    const affectedTasks = [...receipt.created, ...receipt.updated];
    const affectedGoals = [...receipt.goals_created, ...receipt.goals_updated];
    if (affectedGoals.length > 0) {
      window.dispatchEvent(
        new CustomEvent("nucleus:open-goal", {
          detail: {
            projectId,
            goalId: affectedGoals.length === 1 ? affectedGoals[0].goal_id : null,
            taskId: affectedTasks.length === 1 ? affectedTasks[0].task_id : null,
          },
        }),
      );
      return;
    }
    window.dispatchEvent(
      new CustomEvent("nucleus:open-task", {
        detail: {
          projectId,
          taskId: affectedTasks.length === 1 ? affectedTasks[0].task_id : null,
        },
      }),
    );
  }

  function openWorkflowReceipt(receipt: WorkflowReceipt): void {
    if (!projectId) {
      return;
    }
    if (receipt.goal_id) {
      window.dispatchEvent(
        new CustomEvent("nucleus:open-goal", {
          detail: {
            projectId,
            goalId: receipt.goal_id,
            taskId: receipt.current_task_id,
          },
        }),
      );
      return;
    }
    window.dispatchEvent(
      new CustomEvent("nucleus:open-task", {
        detail: { projectId, taskId: receipt.task_id ?? receipt.current_task_id },
      }),
    );
  }

  async function scrollToLatest(): Promise<void> {
    await tick();
    timeline?.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  async function hydrateModelCatalog(): Promise<void> {
    if (retainedModelCatalog) {
      modelCatalog = retainedModelCatalog;
      return;
    }
    modelCatalogRequest ??= listAgentChatModels();
    try {
      retainedModelCatalog = await modelCatalogRequest;
      modelCatalog = retainedModelCatalog;
      const selected = modelCatalog.find((option) => option.model === model);
      if (!selected) {
        const fallback = modelCatalog.find((option) => option.model === DEFAULT_MODEL) ?? modelCatalog[0];
        if (fallback) {
          model = fallback.model;
          reasoningEffort = fallback.default_reasoning_effort;
          retainedModels.set(conversationId, model);
          retainedReasoningEfforts.set(conversationId, reasoningEffort);
        }
      }
    } catch {
      modelCatalogRequest = null;
    }
  }

  function selectModel(nextModel: string): void {
    model = nextModel;
    retainedModels.set(conversationId, model);
    const selected = modelCatalog.find((option) => option.model === nextModel);
    if (
      selected &&
      !selected.supported_reasoning_efforts.some(
        (option) => option.reasoning_effort === reasoningEffort,
      )
    ) {
      reasoningEffort = selected.default_reasoning_effort;
      retainedReasoningEfforts.set(conversationId, reasoningEffort);
    }
  }

  function selectReasoningEffort(effort: string): void {
    reasoningEffort = effort;
    retainedReasoningEfforts.set(conversationId, effort);
  }

  function reasoningLabel(effort: string): string {
    return effort.charAt(0).toUpperCase() + effort.slice(1);
  }

  function resizeComposer(): void {
    if (!composerInput) return;
    composerInput.style.height = "0px";
    composerInput.style.height = `${Math.min(Math.max(composerInput.scrollHeight, 42), 128)}px`;
  }
</script>

<section class="agent-chat" aria-label="Agent chat">
  <div class="chat-timeline" bind:this={timeline} aria-live="polite">
    {#if loadingHistory && messages.length === 0}
      <div class="chat-empty"><Text tone="muted">Loading conversation…</Text></div>
    {:else if messages.length === 0}
      <div class="chat-empty">
        <span class="chat-empty-icon"><Icon icon={messageSquareText} size="md" /></span>
        <Text weight="semibold">Start a conversation</Text>
        <Text tone="muted">
          Chat with Codex in this project. Shape goals and tasks here; details stay in the Tasks panel.
        </Text>
      </div>
    {:else}
      <div class="message-list">
        {#each messages as message (message.id)}
          <article class:message-user={message.role === "user"} class="chat-message">
            <Text size="sm" tone="muted">{message.role === "user" ? "You" : "Codex"}</Text>
            <div class="message-copy">{message.text}</div>
            {#each message.taskReceipts ?? [] as receipt}
              <TaskCreationReceipt {receipt} onOpen={() => openTaskReceipt(receipt)} />
            {/each}
            {#each message.workflowReceipts ?? [] as receipt}
              <TaskWorkflowReceipt {receipt} onOpen={() => openWorkflowReceipt(receipt)} />
            {/each}
          </article>
        {/each}
        {#if pending}
          <article class="chat-message chat-message-pending">
            <Text size="sm" tone="muted">Codex</Text>
            <div class="thinking-dots" aria-label="Codex is working"><span></span><span></span><span></span></div>
          </article>
        {/if}
      </div>
    {/if}
  </div>

  <div class="composer-float">
    {#if failure}<div class="chat-error" role="alert">{failure}</div>{/if}
    <footer class="chat-composer">
      {#if activeGoal || activeTask}
        <div class="context-row">
          {#if activeGoal}
            <div class="active-context">
              <span><strong>Goal</strong> · {activeGoal.title}</span>
              <button type="button" aria-label="Clear active goal context" onclick={onClearActiveGoal}>×</button>
            </div>
          {/if}
          {#if activeTask}
            <div class="active-context">
              <span><strong>Task</strong> · {activeTask.title}</span>
              <button type="button" aria-label="Clear active task context" onclick={onClearActiveTask}>×</button>
            </div>
          {/if}
        </div>
      {/if}
      <textarea
        bind:this={composerInput}
        bind:value={draft}
        oninput={resizeComposer}
        onkeydown={handleComposerKeydown}
        placeholder={projectId ? "Ask Nucleus anything" : "Select a project first"}
        aria-label="Message Codex"
        rows="1"
        disabled={!projectId || pending || loadingHistory}
      ></textarea>
      <div class="composer-toolbar">
        <div class="route-controls">
          <div class="route-select route-select-model">
            <Select
              value={model}
              options={modelOptions}
              variant="ghost"
              size="sm"
              native={false}
              menuMinWidth="16rem"
              ariaLabel="Chat model"
              disabled={pending || loadingHistory}
              onValueChange={selectModel}
            />
            <span class="route-chevron" aria-hidden="true"><Icon icon={chevronDown} size="xs" /></span>
          </div>
          <div class="route-select route-select-reasoning">
            <Select
              value={reasoningEffort}
              options={reasoningOptions}
              variant="ghost"
              size="sm"
              native={false}
              menuMinWidth="13rem"
              ariaLabel="Reasoning effort"
              disabled={pending || loadingHistory}
              onValueChange={selectReasoningEffort}
            />
            <span class="route-chevron" aria-hidden="true"><Icon icon={chevronDown} size="xs" /></span>
          </div>
        </div>
        <button
          type="button"
          class="send-button"
          aria-label={pending ? "Codex is working" : "Send message"}
          onclick={() => void submit()}
          disabled={!projectId || !draft.trim() || pending || loadingHistory}
        >
          <Icon icon={arrowUp} size="xs" />
        </button>
      </div>
    </footer>
  </div>
</section>

<style>
  .agent-chat {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--poodle-color-background-canvas);
  }

  .chat-timeline {
    box-sizing: border-box;
    min-height: 0;
    overflow: auto;
    height: 100%;
    padding: clamp(1rem, 4vw, 3rem);
    padding-bottom: clamp(11rem, 24vh, 14rem);
  }

  .chat-empty {
    display: grid;
    justify-items: center;
    align-content: center;
    gap: 0.55rem;
    width: min(30rem, 100%);
    min-height: 100%;
    margin: 0 auto;
    text-align: center;
  }

  .chat-empty-icon {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    margin-bottom: 0.2rem;
    color: var(--poodle-color-text-secondary);
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-background-surface);
  }

  .message-list {
    display: grid;
    gap: 1.5rem;
    width: min(48rem, 100%);
    margin: 0 auto;
  }

  .chat-message {
    display: grid;
    gap: 0.35rem;
    max-width: 90%;
  }

  .message-user {
    justify-self: end;
    width: fit-content;
    padding: 0.7rem 0.85rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-background-surface);
  }

  .message-copy {
    color: var(--poodle-color-text-primary);
    font-size: 0.875rem;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .chat-message-pending {
    min-height: 2.5rem;
  }

  .thinking-dots {
    display: flex;
    gap: 0.28rem;
    align-items: center;
    height: 1.25rem;
  }

  .thinking-dots span {
    width: 0.35rem;
    height: 0.35rem;
    border-radius: 50%;
    background: var(--poodle-color-text-secondary);
    animation: pulse 1.2s infinite ease-in-out;
  }

  .thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
  .thinking-dots span:nth-child(3) { animation-delay: 0.3s; }

  .composer-float {
    position: absolute;
    z-index: 5;
    right: clamp(0.75rem, 3vw, 2rem);
    bottom: clamp(0.75rem, 2vw, 1.35rem);
    left: clamp(0.75rem, 3vw, 2rem);
    display: grid;
    gap: 0.45rem;
    width: min(48rem, calc(100% - clamp(1.5rem, 6vw, 4rem)));
    margin: 0 auto;
  }

  .chat-composer {
    display: grid;
    gap: 0.25rem;
    padding: 0.65rem 0.7rem 0.7rem;
    border: 1px solid var(--poodle-color-border-default);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--poodle-color-background-surface) 96%, transparent);
    box-shadow: 0 1rem 3rem rgb(0 0 0 / 28%), 0 0 0 1px rgb(255 255 255 / 2%);
    backdrop-filter: blur(18px);
  }

  .composer-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-width: 0;
    min-height: 2.15rem;
    padding: 0 0.05rem;
  }

  .route-controls,
  .context-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .context-row {
    flex-wrap: wrap;
    gap: 0.3rem;
    padding: 0.15rem 0.2rem 0;
  }

  .route-select {
    position: relative;
    display: flex;
    align-items: center;
    height: 2rem;
    min-width: 0;
  }

  .route-select-model { max-width: 13rem; }
  .route-select-reasoning { max-width: 9rem; }

  .route-select :global(.poodle-select__trigger) {
    display: flex;
    align-items: center;
    height: 2rem;
    max-width: 100%;
    padding: 0 1.15rem 0 0.25rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .route-select :global(.poodle-select__value) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .route-chevron {
    position: absolute;
    top: 50%;
    right: 0.15rem;
    display: grid;
    place-items: center;
    color: var(--poodle-color-text-secondary);
    opacity: 0.65;
    pointer-events: none;
    transform: translateY(-50%);
  }

  .active-context {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    width: fit-content;
    max-width: 100%;
    padding: 0.25rem 0.35rem 0.25rem 0.5rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
  }

  .active-context span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .active-context button {
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    padding: 0;
    color: inherit;
    font: inherit;
    border: 0;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
  }

  .active-context button:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-canvas);
  }

  .chat-composer textarea {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 2.625rem;
    max-height: 8rem;
    resize: none;
    padding: 0.3rem 0.25rem 0.5rem;
    color: var(--poodle-color-text-primary);
    font-family: inherit;
    font-size: 0.8125rem;
    font-weight: 400;
    line-height: 1.45;
    border: 0;
    outline: none;
    background: transparent;
  }

  .chat-composer textarea::placeholder {
    color: color-mix(in srgb, var(--poodle-color-text-secondary) 55%, transparent);
    opacity: 1;
  }

  .chat-composer textarea:disabled {
    opacity: 0.55;
  }

  .send-button {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    color: var(--poodle-color-background-canvas);
    border: 0;
    border-radius: 50%;
    background: var(--poodle-color-text-primary);
    cursor: pointer;
  }

  .send-button:hover:not(:disabled) { transform: translateY(-1px); }
  .send-button:disabled { opacity: 0.28; cursor: default; }

  .chat-error {
    padding: 0.55rem 0.65rem;
    color: var(--poodle-color-status-danger);
    font-size: 0.8rem;
    border: 1px solid var(--poodle-color-status-danger);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
  }

  @media (max-width: 36rem) {
    .chat-timeline { padding-bottom: 13rem; }
    .composer-toolbar { align-items: end; }
    .route-controls { flex-wrap: wrap; }
    .route-select-model { max-width: 10rem; }
    .route-select-reasoning { max-width: 7.5rem; }
  }

  @keyframes pulse {
    0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-0.15rem); }
  }
</style>
