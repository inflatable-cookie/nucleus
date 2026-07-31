<script module lang="ts">
  import type { AgentChatModelOption } from "./control/agentChat";

  type ChatMessage = {
    id: string;
    turnId: string;
    sequence: number;
    role: "user" | "assistant";
    text: string;
    taskReceipts: import("./control/agentChat").TaskAuthoringReceipt[];
    workflowReceipts: import("./control/agentChat").TaskWorkflowReceipt[];
  };

  // Module-level so conversation state survives panel remounts; bounded so
  // long sessions do not accumulate every conversation ever opened.
  const RETAINED_CONVERSATION_LIMIT = 32;
  const retainedMessages = new Map<string, ChatMessage[]>();
  const retainedActivities = new Map<
    string,
    import("./control/agentChat").AgentChatActivity[]
  >();
  const retainedQuestions = new Map<
    string,
    import("./control/agentChat").AgentChatQuestionExchange[]
  >();
  const retainedTurns = new Map<
    string,
    import("./agentChatTranscript").AgentTranscriptTurn[]
  >();
  const retainedModels = new Map<string, string>();
  const retainedReasoningEfforts = new Map<string, string>();
  const retainedHarnessModes = new Map<
    string,
    import("./control/agentChat").AgentChatHarnessMode
  >();
  const retainedPendingConversations = new Set<string>();

  function retain<Value>(cache: Map<string, Value>, key: string, value: Value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > RETAINED_CONVERSATION_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  let retainedModelCatalog: AgentChatModelOption[] | null = null;
  let modelCatalogRequest: Promise<AgentChatModelOption[]> | null = null;

  const DEFAULT_MODEL = "gpt-5.4-mini";
  const DEFAULT_REASONING_EFFORT = "low";
  const DEFAULT_HARNESS_MODE = "normal";
  const REASONING_EFFORT_RANK: Readonly<Record<string, number>> = {
    ultra: 0,
    max: 1,
    xhigh: 2,
    high: 3,
    medium: 4,
    low: 5,
    minimal: 6,
    none: 7,
  };
</script>

<script lang="ts">
  import { listen } from "@tauri-apps/api/event";
  import {
    AgentChatInput,
    AgentQuestion,
    AgentTranscript,
    Button,
    Icon,
    ModelPicker,
    Text,
    type AgentChatAttachment,
    type AgentQuestionAnswer,
    type AgentQuestionItem,
    type ModelCapabilityAxis,
    type ModelOption,
    type ModelSelection,
  } from "@poodle/svelte";
  import { messageSquareText } from "@poodle/icons-lucide";
  import TaskCreationReceipt from "./TaskCreationReceipt.svelte";
  import TaskWorkflowReceipt from "./TaskWorkflowReceipt.svelte";
  import {
    assembleAgentTranscript,
    type AgentTranscriptTurn,
  } from "./agentChatTranscript";
  import type { ControlGoalRecordDto, ControlTaskRecordDto } from "./control";
  import type {
    AgentChatActivity,
    AgentChatHarnessMode,
    AgentChatQuestionExchange,
    TaskAuthoringReceipt,
    TaskWorkflowReceipt as WorkflowReceipt,
  } from "./control/agentChat";
  import {
    answerAgentChatQuestion,
    cancelAgentChatTurn,
    listAgentChatModels,
    loadAgentChatHistory,
    sendAgentChatMessage,
  } from "./control/agentChat";

  let {
    conversationId,
    projectId,
    resourceId = null,
    activeGoal,
    activeTask,
    onClearActiveGoal,
    onClearActiveTask,
  }: {
    conversationId: string;
    projectId: string | null;
    resourceId?: string | null;
    activeGoal: ControlGoalRecordDto | null;
    activeTask: ControlTaskRecordDto | null;
    onClearActiveGoal: () => void;
    onClearActiveTask: () => void;
  } = $props();

  let activeConversationId = $state("");
  let messages = $state<ChatMessage[]>([]);
  let activities = $state<AgentChatActivity[]>([]);
  let questions = $state<AgentChatQuestionExchange[]>([]);
  let turns = $state<AgentTranscriptTurn[]>([]);
  let draft = $state("");
  let pending = $state(false);
  let cancelRequested = $state(false);
  let loadingHistory = $state(false);
  let failure = $state<string | null>(null);
  let model = $state(DEFAULT_MODEL);
  let reasoningEffort = $state(DEFAULT_REASONING_EFFORT);
  let harnessMode = $state<AgentChatHarnessMode>(DEFAULT_HARNESS_MODE);
  let modelCatalog = $state<AgentChatModelOption[]>(retainedModelCatalog ?? []);
  let expandedToolRuns = $state<string[]>([]);
  let expandedToolCalls = $state<string[]>([]);
  let questionIndex = $state(0);
  let questionSelections = $state<string[]>([]);
  let collectedQuestionAnswers = $state<AgentQuestionAnswer[]>([]);
  let answeringQuestion = $state(false);
  let questionComponent = $state<{ submit: () => void } | null>(null);
  let hydrationVersion = 0;

  const modelPickerAxes: ModelCapabilityAxis[] = [
    {
      key: "reasoning",
      label: "Reasoning",
      kind: "select",
      options: [
        {
          value: DEFAULT_REASONING_EFFORT,
          label: reasoningLabel(DEFAULT_REASONING_EFFORT),
        },
      ],
      defaultValue: DEFAULT_REASONING_EFFORT,
    },
    {
      key: "mode",
      label: "Mode",
      kind: "select",
      options: [
        { value: "normal", label: "Normal" },
        { value: "plan", label: "Plan" },
      ],
      defaultValue: DEFAULT_HARNESS_MODE,
    },
  ];
  const modelPickerModels = $derived.by(() => {
    const options: ModelOption[] = modelCatalog.map((option) => ({
      value: option.model,
      label: option.display_name,
      icon: "sparkles",
      axes: [
        {
          key: "reasoning",
          options: [...option.supported_reasoning_efforts]
            .sort(
              (left, right) =>
                reasoningEffortRank(left.reasoning_effort) -
                reasoningEffortRank(right.reasoning_effort),
            )
            .map((effort) => ({
              value: effort.reasoning_effort,
              label: reasoningLabel(effort.reasoning_effort),
            })),
          defaultValue: option.default_reasoning_effort,
        },
        {
          key: "mode",
          options: [
            { value: "normal", label: "Normal" },
            { value: "plan", label: "Plan" },
          ],
          defaultValue: DEFAULT_HARNESS_MODE,
        },
      ],
    }));
    if (!options.some((option) => option.value === model)) {
      options.unshift({
        value: model,
        label: model,
        icon: "sparkles",
        axes: [
          {
            key: "reasoning",
            options: [{ value: reasoningEffort, label: reasoningLabel(reasoningEffort) }],
            defaultValue: reasoningEffort,
          },
          {
            key: "mode",
            options: [
              { value: "normal", label: "Normal" },
              { value: "plan", label: "Plan" },
            ],
            defaultValue: DEFAULT_HARNESS_MODE,
          },
        ],
      });
    }
    return options;
  });
  const modelSelection = $derived<ModelSelection>({
    model,
    axes: { reasoning: reasoningEffort, mode: harnessMode },
  });
  const contextAttachments = $derived<AgentChatAttachment[]>([
    ...(activeGoal
      ? [{ id: "active-goal", label: `Goal · ${activeGoal.title}`, kind: "goal" }]
      : []),
    ...(activeTask
      ? [{ id: "active-task", label: `Task · ${activeTask.title}`, kind: "task" }]
      : []),
  ]);
  const transcriptItems = $derived.by(() =>
    assembleAgentTranscript(
      messages,
      activities,
      turns,
      pending ? (cancelRequested ? "Cancelling…" : "Working…") : null,
      conversationId,
      questions,
    ),
  );
  const pendingQuestion = $derived(
    questions.find((question) => question.status === "pending") ?? null,
  );
  const questionItems = $derived<AgentQuestionItem[]>(
    pendingQuestion?.questions.map((question) => ({
      id: question.question_id,
      header: question.header || undefined,
      prompt: question.prompt,
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description ?? undefined,
      })),
      allowMultiple: question.kind === "multiple_choice",
    })) ?? [],
  );
  const questionCanSubmit = $derived(
    !answeringQuestion &&
      (draft.trim().length > 0 || questionSelections.length > 0),
  );
  const receiptMessages = $derived(
    messages.filter(
      (message) => message.taskReceipts.length > 0 || message.workflowReceipts.length > 0,
    ),
  );

  $effect(() => {
    if (activeConversationId !== conversationId) {
      activeConversationId = conversationId;
      messages = retainedMessages.get(conversationId) ?? [];
      activities = retainedActivities.get(conversationId) ?? [];
      questions = retainedQuestions.get(conversationId) ?? [];
      turns = retainedTurns.get(conversationId) ?? [];
      pending = retainedPendingConversations.has(conversationId);
      questionIndex = 0;
      questionSelections = [];
      collectedQuestionAnswers = [];
      answeringQuestion = false;
      model = retainedModels.get(conversationId) ?? DEFAULT_MODEL;
      reasoningEffort = retainedReasoningEfforts.get(conversationId) ?? DEFAULT_REASONING_EFFORT;
      harnessMode = retainedHarnessModes.get(conversationId) ?? DEFAULT_HARNESS_MODE;
      if (projectId) {
        void hydrateModelCatalog();
        void hydrateHistory(projectId, conversationId);
      }
    }
  });

  $effect(() => {
    const unlisten = listen<AgentChatActivity>("agent-chat:activity", ({ payload }) => {
      if (payload.conversation_id !== conversationId) {
        return;
      }
      activities = [...activities, payload];
      retain(retainedActivities, conversationId, activities);
      adoptTimelineTurnId(payload.turn_id);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  });

  $effect(() => {
    const unlisten = listen<AgentChatQuestionExchange>("agent-chat:question", ({ payload }) => {
      if (payload.conversation_id !== conversationId) {
        return;
      }
      questions = [
        ...questions.filter((question) => question.callback_id !== payload.callback_id),
        payload,
      ];
      retain(retainedQuestions, conversationId, questions);
      adoptTimelineTurnId(payload.turn_id);
      questionIndex = 0;
      questionSelections = [];
      collectedQuestionAnswers = [];
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
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
        turnId: message.turn_id,
        sequence: message.sequence,
        role: message.role,
        text: message.text,
        taskReceipts: message.task_receipts,
        workflowReceipts: message.workflow_receipts,
      }));
      activities = history.activities;
      questions = history.questions;
      turns = history.turns.map((turn) => ({
        turnId: turn.turn_id,
        status: turn.status,
      }));
      retain(retainedMessages, nextConversationId, messages);
      retain(retainedActivities, nextConversationId, activities);
      retain(retainedQuestions, nextConversationId, questions);
      retain(retainedTurns, nextConversationId, turns);
      model = history.model ?? model;
      reasoningEffort = history.reasoning_effort ?? reasoningEffort;
      harnessMode = history.harness_mode ?? harnessMode;
      if (history.model) {
        retain(retainedModels, nextConversationId, history.model);
      }
      if (history.reasoning_effort) {
        retain(retainedReasoningEfforts, nextConversationId, history.reasoning_effort);
      }
      if (history.harness_mode) {
        retain(retainedHarnessModes, nextConversationId, history.harness_mode);
      }
    } catch (caught) {
      if (version === hydrationVersion) {
        failure = caught instanceof Error ? caught.message : String(caught);
      }
    } finally {
      if (version === hydrationVersion) {
        loadingHistory = false;
        pending = retainedPendingConversations.has(nextConversationId);
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
    cancelRequested = false;
    retainedPendingConversations.add(conversationId);
    draft = "";
    const optimisticMessageId = `user:${crypto.randomUUID()}`;
    appendMessage({
      id: optimisticMessageId,
      turnId: `pending:${optimisticMessageId}`,
      sequence: nextMessageSequence(),
      role: "user",
      text: message,
      taskReceipts: [],
      workflowReceipts: [],
    });

    try {
      const reply = await sendAgentChatMessage({
        conversation_id: conversationId,
        project_id: projectId,
        resource_id: resourceId,
        message,
        active_goal_id: activeGoal?.goal_id ?? null,
        active_task_id: activeTask?.task_id ?? null,
        model,
        reasoning_effort: reasoningEffort,
        harness_mode: harnessMode,
      });
      model = reply.model;
      retain(retainedModels, conversationId, reply.model);
      reasoningEffort = reply.reasoning_effort ?? reasoningEffort;
      if (reply.reasoning_effort) {
        retain(retainedReasoningEfforts, conversationId, reply.reasoning_effort);
      }
      harnessMode = reply.harness_mode;
      retain(retainedHarnessModes, conversationId, reply.harness_mode);
      messages = messages.map((message) =>
        message.id === optimisticMessageId
          ? {
              ...message,
              id: `message:${reply.timeline_turn_id}:user`,
              turnId: reply.timeline_turn_id,
            }
          : message,
      );
      retain(retainedMessages, conversationId, messages);
      appendMessage({
        id: `message:${reply.timeline_turn_id}:assistant`,
        turnId: reply.timeline_turn_id,
        sequence: nextMessageSequence(),
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
      const reason = caught instanceof Error ? caught.message : String(caught);
      if (!cancelRequested) {
        messages = messages.filter((message) => message.id !== optimisticMessageId);
        retain(retainedMessages, conversationId, messages);
      }
      await hydrateHistory(projectId, conversationId);
      failure = reason;
    } finally {
      retainedPendingConversations.delete(conversationId);
      pending = false;
      cancelRequested = false;
    }
  }

  function submitComposer(): void {
    if (pendingQuestion) {
      questionComponent?.submit();
      return;
    }
    void submit();
  }

  async function answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    if (!projectId || !pendingQuestion || answeringQuestion) {
      return;
    }
    const nextAnswers = [...collectedQuestionAnswers, answer];
    if (questionIndex + 1 < questionItems.length) {
      collectedQuestionAnswers = nextAnswers;
      questionIndex += 1;
      questionSelections = [];
      draft = "";
      return;
    }

    answeringQuestion = true;
    failure = null;
    try {
      const answered = await answerAgentChatQuestion({
        project_id: projectId,
        conversation_id: conversationId,
        turn_id: pendingQuestion.turn_id,
        callback_id: pendingQuestion.callback_id,
        runtime_operation_id: pendingQuestion.runtime_operation_id,
        event_sequence: pendingQuestion.event_sequence,
        provider_request_ref: pendingQuestion.provider_request_ref,
        answers: nextAnswers.map((item) => ({
          question_id: item.questionId,
          selected_option_ids: item.values,
          text: item.outcome === "override" ? item.text : null,
          skipped: item.outcome === "declined",
        })),
      });
      questions = [
        ...questions.filter((question) => question.callback_id !== answered.callback_id),
        answered,
      ];
      retain(retainedQuestions, conversationId, questions);
      questionIndex = 0;
      questionSelections = [];
      collectedQuestionAnswers = [];
      draft = "";
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    } finally {
      answeringQuestion = false;
    }
  }

  async function cancelTurn(): Promise<void> {
    if (!projectId || !pending || cancelRequested) {
      return;
    }
    failure = null;
    try {
      cancelRequested = await cancelAgentChatTurn(projectId, conversationId);
      if (!cancelRequested) {
        failure = "No active turn was available to cancel.";
      }
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }
  }

  function appendMessage(message: ChatMessage): void {
    messages = [...messages, message];
    retain(retainedMessages, conversationId, messages);
  }

  function adoptTimelineTurnId(turnId: string): void {
    let changed = false;
    messages = messages.map((message) => {
      if (message.role !== "user" || !message.turnId.startsWith("pending:")) {
        return message;
      }
      changed = true;
      return {
        ...message,
        id: `message:${turnId}:user`,
        turnId,
      };
    });
    if (changed) {
      retain(retainedMessages, conversationId, messages);
    }
  }

  function nextMessageSequence(): number {
    return messages.reduce((highest, message) => Math.max(highest, message.sequence), -1) + 1;
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
          retain(retainedModels, conversationId, model);
          retain(retainedReasoningEfforts, conversationId, reasoningEffort);
        }
      }
    } catch {
      modelCatalogRequest = null;
    }
  }

  function selectModelRoute(selection: ModelSelection): void {
    const nextModel = selection.model;
    model = nextModel;
    retain(retainedModels, conversationId, model);
    const selected = modelCatalog.find((option) => option.model === nextModel);
    const selectedEffort = selection.axes.reasoning;
    reasoningEffort =
      typeof selectedEffort === "string"
        ? selectedEffort
        : selected?.default_reasoning_effort ?? DEFAULT_REASONING_EFFORT;
    retain(retainedReasoningEfforts, conversationId, reasoningEffort);
    const selectedMode = selection.axes.mode;
    harnessMode =
      selectedMode === "normal" || selectedMode === "plan"
        ? selectedMode
        : DEFAULT_HARNESS_MODE;
    retain(retainedHarnessModes, conversationId, harnessMode);
  }

  function reasoningLabel(effort: string): string {
    return effort.charAt(0).toUpperCase() + effort.slice(1);
  }

  function reasoningEffortRank(effort: string): number {
    return REASONING_EFFORT_RANK[effort.toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
  }

  function removeContextAttachment(id: string): void {
    if (id === "active-goal") {
      onClearActiveGoal();
    } else if (id === "active-task") {
      onClearActiveTask();
    }
  }

  function toggle(values: string[], id: string): string[] {
    return values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
  }
</script>

<section class="agent-chat" aria-label="Agent chat">
  <div class="chat-timeline">
    {#if loadingHistory && transcriptItems.length === 0}
      <div class="chat-empty"><Text tone="muted">Loading conversation…</Text></div>
    {:else if transcriptItems.length === 0}
      <div class="chat-empty">
        <span class="chat-empty-icon"><Icon icon={messageSquareText} size="md" /></span>
        <Text weight="semibold">Start a conversation</Text>
        <Text tone="muted">
          Chat with Codex in this project. Shape goals and tasks here; details stay in the Tasks panel.
        </Text>
      </div>
    {:else}
      <div class="transcript-shell">
        <AgentTranscript
          items={transcriptItems}
          autoScroll
          size="sm"
          density="compact"
          ariaLabel="Agent conversation and activity"
          expandedToolRuns={expandedToolRuns}
          expandedToolCalls={expandedToolCalls}
          onToolRunToggle={(id) =>
            (expandedToolRuns = toggle(expandedToolRuns, id))}
          onToolCallToggle={(id) =>
            (expandedToolCalls = toggle(expandedToolCalls, id))}
        />
      </div>
    {/if}

    {#if pending}
      <div class="pending-actions">
        <Button
          variant="secondary"
          size="sm"
          disabled={cancelRequested}
          onClick={() => void cancelTurn()}
        >
          {cancelRequested ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
    {/if}

    {#if receiptMessages.length > 0}
      <div class="receipt-list" aria-label="Agent action receipts">
        {#each receiptMessages as message (message.id)}
          {#each message.taskReceipts as receipt}
            <TaskCreationReceipt {receipt} onOpen={() => openTaskReceipt(receipt)} />
          {/each}
          {#each message.workflowReceipts as receipt}
            <TaskWorkflowReceipt {receipt} onOpen={() => openWorkflowReceipt(receipt)} />
          {/each}
        {/each}
      </div>
    {/if}
  </div>

  <div class="composer-float">
    {#if failure}<div class="chat-error" role="alert">{failure}</div>{/if}
    <AgentChatInput
      bind:value={draft}
      placeholder={projectId ? "Ask Nucleus anything" : "Select a project first"}
      ariaLabel="Message Codex"
      submitLabel="Send message"
      minRows={2}
      maxRows={8}
      size="sm"
      status={pendingQuestion ? "questioning" : pending ? "busy" : "idle"}
      questionCanSubmit={questionCanSubmit}
      attachments={contextAttachments}
      disabled={!projectId || loadingHistory || answeringQuestion}
      onSubmit={submitComposer}
      onStop={() => void cancelTurn()}
      onRemoveAttachment={removeContextAttachment}
    >
      {#snippet question()}
        <AgentQuestion
          bind:this={questionComponent}
          questions={questionItems}
          activeIndex={questionIndex}
          selections={questionSelections}
          override={draft}
          dismissible
          size="sm"
          density="compact"
          onSelectionChange={(values) => (questionSelections = values)}
          onSubmit={(answer) => void answerQuestion(answer)}
        />
      {/snippet}
      {#snippet toolbar()}
        <ModelPicker
          models={modelPickerModels}
          axes={modelPickerAxes}
          value={modelSelection}
          ariaLabel="Chat model and reasoning"
          showModelDescriptions={false}
          emphasis="subdued"
          size="sm"
          disabled={pending || loadingHistory}
          onChange={selectModelRoute}
        />
      {/snippet}
    </AgentChatInput>
  </div>
</section>

<style>
  .agent-chat {
    position: relative;
    isolation: isolate;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--poodle-color-background-canvas);
  }

  .agent-chat::after {
    content: "";
    position: absolute;
    z-index: 4;
    right: 0;
    bottom: 0;
    left: 0;
    height: clamp(5rem, 18vh, 8rem);
    pointer-events: none;
    background: linear-gradient(
      to bottom,
      transparent,
      color-mix(in srgb, var(--poodle-color-background-canvas) 28%, transparent) 48%,
      color-mix(in srgb, var(--poodle-color-background-canvas) 58%, transparent) 100%
    );
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    -webkit-mask-image: linear-gradient(to bottom, transparent, black 38%);
    mask-image: linear-gradient(to bottom, transparent, black 38%);
  }

  .chat-timeline {
    box-sizing: border-box;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto auto;
    gap: 0.65rem;
    min-height: 0;
    overflow: hidden;
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

  .transcript-shell {
    width: min(48rem, 100%);
    height: 100%;
    min-height: 0;
    margin: 0 auto;
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

  .receipt-list {
    position: relative;
    z-index: 5;
    display: grid;
    gap: 0.55rem;
    width: min(48rem, 100%);
    max-height: 10rem;
    margin: 0 auto;
    overflow: auto;
  }

  .pending-actions {
    position: relative;
    z-index: 5;
    justify-self: end;
    width: min(48rem, 100%);
    margin: 0 auto;
    text-align: right;
  }

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

  :global(html[data-nucleus-split-resizing]) .agent-chat::after {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

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
  }
</style>
