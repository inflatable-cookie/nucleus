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
  const retainedPlanDecisions = new Map<
    string,
    import("./control/agentChat").AgentChatPlanDecision[]
  >();
  const retainedSubagentDirectories = new Map<
    string,
    import("./control/agentChat").AgentChatSubagentDirectory[]
  >();
  const retainedActorSelections = new Map<
    string,
    import("./control/agentChat").AgentChatActorSelection
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
  const retainedProviderInstances = new Map<string, string>();
  const retainedProviderInstanceRevisions = new Map<string, string>();
  const retainedProtocolFacades = new Map<string, string>();
  const retainedProviderIds = new Map<string, string | null>();
  const retainedDrafts = new Map<string, string>();
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
  let retainedProviderCatalogue:
    import("./control/agentChat").AgentChatProviderCatalogue | null = null;
  let providerCatalogueRequest:
    Promise<import("./control/agentChat").AgentChatProviderCatalogue> | null = null;

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
  import { onDestroy } from "svelte";
  import {
    AgentChatInput,
    AgentPlan,
    AgentQuestion,
    AgentTranscript,
    Button,
    Icon,
    ModelPicker,
    Select,
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
    filterAgentChatActivities,
    latestFailedTurnNotice,
    type AgentTranscriptTurn,
  } from "./agentChatTranscript";
  import type { ControlGoalRecordDto, ControlTaskRecordDto } from "./control";
  import type { AgentChatDefaults } from "./settings/client";
  import type {
    AgentChatActivity,
    AgentChatActorSelection,
    AgentChatHarnessMode,
    AgentChatPlanDecision,
    AgentChatQuestionExchange,
    AgentChatSubagentDirectory,
    AgentChatProviderCatalogue,
    TaskAuthoringReceipt,
    TaskWorkflowReceipt as WorkflowReceipt,
  } from "./control/agentChat";
  import {
    answerAgentChatQuestion,
    cancelAgentChatTurn,
    decideAgentChatPlan,
    loadAgentChatProviderCatalogue,
    loadAgentChatHistory,
    selectAgentChatActor,
    sendAgentChatMessage,
  } from "./control/agentChat";
  import {
    mergePreparedReworkDraft,
    type AgentChatDraftRequest,
  } from "./reviewRework";
  import {
    modelRouteKey,
    selectableProviderInstances,
    shouldShowProviderSelector,
  } from "./providerSelection";

  let {
    conversationId,
    projectId,
    resourceId = null,
    activeGoal,
    activeTask,
    agentChatDefaults,
    onClearActiveGoal,
    onClearActiveTask,
    onConversationActive,
    draftRequest = null,
    onDraftRequestConsumed,
  }: {
    conversationId: string;
    projectId: string | null;
    resourceId?: string | null;
    activeGoal: ControlGoalRecordDto | null;
    activeTask: ControlTaskRecordDto | null;
    agentChatDefaults: AgentChatDefaults;
    onClearActiveGoal: () => void;
    onClearActiveTask: () => void;
    onConversationActive?: () => void;
    draftRequest?: AgentChatDraftRequest | null;
    onDraftRequestConsumed?: (requestId: number) => void;
  } = $props();

  let activeConversationId = $state("");
  let messages = $state<ChatMessage[]>([]);
  let activities = $state<AgentChatActivity[]>([]);
  let questions = $state<AgentChatQuestionExchange[]>([]);
  let planDecisions = $state<AgentChatPlanDecision[]>([]);
  let decidingPlan = $state(false);
  let subagentDirectories = $state<AgentChatSubagentDirectory[]>([]);
  let actorSelection = $state<AgentChatActorSelection>({
    project_id: "",
    conversation_id: "",
    kind: "all",
    runtime_operation_id: null,
    actor_id: null,
  });
  let turns = $state<AgentTranscriptTurn[]>([]);
  let draft = $state("");
  let pending = $state(false);
  let cancelRequested = $state(false);
  let loadingHistory = $state(false);
  let failure = $state<string | null>(null);
  let model = $state(DEFAULT_MODEL);
  let reasoningEffort = $state(DEFAULT_REASONING_EFFORT);
  let harnessMode = $state<AgentChatHarnessMode>(DEFAULT_HARNESS_MODE);
  let providerInstanceId = $state("");
  let providerInstanceRevision = $state("");
  let protocolFacadeId = $state("");
  let providerId = $state<string | null>(null);
  let providerCatalogue = $state<AgentChatProviderCatalogue>(
    retainedProviderCatalogue ?? { instances: [] },
  );
  let modelCatalog = $state<AgentChatModelOption[]>([]);
  let expandedToolRuns = $state<string[]>([]);
  let expandedToolCalls = $state<string[]>([]);
  let questionIndex = $state(0);
  let questionSelections = $state<string[]>([]);
  let collectedQuestionAnswers = $state<AgentQuestionAnswer[]>([]);
  let answeringQuestion = $state(false);
  let questionComponent = $state<{ submit: () => void } | null>(null);
  let composerRegion = $state<HTMLDivElement | null>(null);
  let hydrationVersion = 0;
  let historyOwnsRoute = $state(false);
  let appliedDraftRequestId = $state(0);

  $effect(() => {
    window.dispatchEvent(new CustomEvent("nucleus:agent-turn-command-state", {
      detail: { running: pending },
    }));
  });

  $effect(() => {
    const request = draftRequest;
    if (
      !request
      || request.requestId === appliedDraftRequestId
      || request.projectId !== projectId
      || request.taskId !== activeTask?.task_id
    ) return;
    const currentDraft = activeConversationId === conversationId
      ? draft
      : retainedDrafts.get(conversationId) ?? draft;
    setDraft(mergePreparedReworkDraft(currentDraft, request.text));
    appliedDraftRequestId = request.requestId;
    onDraftRequestConsumed?.(request.requestId);
  });

  function setDraft(next: string): void {
    draft = next;
    retain(retainedDrafts, conversationId, next);
  }

  function retainDraft(next: string): void {
    retain(retainedDrafts, conversationId, next);
  }

  onDestroy(() => {
    retain(retainedDrafts, activeConversationId || conversationId, draft);
  });

  $effect(() => {
    const handleCommandCancel = () => {
      if (pending) void cancelTurn();
    };
    window.addEventListener("nucleus:command-cancel-agent-turn", handleCommandCancel);
    return () => {
      window.removeEventListener("nucleus:command-cancel-agent-turn", handleCommandCancel);
    };
  });

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
  ];
  const modelPickerModels = $derived.by(() => {
    const options: ModelOption[] = modelCatalog.map((option) => ({
      value: modelRouteKey(option),
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
      ],
    }));
    const selectedRouteKey = modelRouteKey({ model, provider_id: providerId });
    if (!options.some((option) => option.value === selectedRouteKey)) {
      options.unshift({
        value: selectedRouteKey,
        label: model,
        icon: "sparkles",
        axes: [
          {
            key: "reasoning",
            options: [{ value: reasoningEffort, label: reasoningLabel(reasoningEffort) }],
            defaultValue: reasoningEffort,
          },
        ],
      });
    }
    return options;
  });
  const modelSelection = $derived<ModelSelection>({
    model: modelRouteKey({ model, provider_id: providerId }),
    axes: { reasoning: reasoningEffort },
  });
  const readyProviderInstances = $derived(
    selectableProviderInstances(providerCatalogue),
  );
  const providerOptions = $derived(
    readyProviderInstances.map((instance) => ({
      value: instance.provider_instance_id,
      label: instance.display_name,
    })),
  );
  const contextAttachments = $derived<AgentChatAttachment[]>([
    ...(activeGoal
      ? [{ id: "active-goal", label: `Goal · ${activeGoal.title}`, kind: "goal" }]
      : []),
    ...(activeTask
      ? [{ id: "active-task", label: `Task · ${activeTask.title}`, kind: "task" }]
      : []),
  ]);
  const visibleActivities = $derived(
    filterAgentChatActivities(activities, actorSelection),
  );
  const transcriptItems = $derived.by(() =>
    assembleAgentTranscript(
      messages,
      visibleActivities,
      turns,
      pending ? (cancelRequested ? "Cancelling…" : "Working…") : null,
      conversationId,
      questions,
      planDecisions,
    ),
  );
  const actorChoices = $derived.by(() => [
    {
      value: "all",
      label: "All work",
      selection: actorSelectionFor("all"),
    },
    {
      value: "primary",
      label: "Main agent",
      selection: actorSelectionFor("primary"),
    },
    ...subagentDirectories.flatMap((directory) =>
      directory.subagents.map((subagent) => ({
        value: childSelectionValue(directory.runtime_operation_id, subagent.subagent_id),
        label: childSelectionLabel(directory, subagent),
        selection: {
          project_id: projectId ?? directory.project_id,
          conversation_id: conversationId,
          kind: "subagent" as const,
          runtime_operation_id: directory.runtime_operation_id,
          actor_id: subagent.subagent_id,
        },
      })),
    ),
  ]);
  const actorOptions = $derived(
    actorChoices.map(({ value, label }) => ({ value, label })),
  );
  const actorSelectionValue = $derived(selectionValue(actorSelection));
  const pendingQuestion = $derived(
    questions.find((question) => question.status === "pending") ?? null,
  );
  const pendingPlan = $derived(
    planDecisions.find((decision) => decision.status === "pending") ?? null,
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
  const failedTurnNotice = $derived(latestFailedTurnNotice(turns));

  $effect(() => {
    if (activeConversationId !== conversationId) {
      if (activeConversationId) retain(retainedDrafts, activeConversationId, draft);
      activeConversationId = conversationId;
      messages = retainedMessages.get(conversationId) ?? [];
      activities = retainedActivities.get(conversationId) ?? [];
      questions = retainedQuestions.get(conversationId) ?? [];
      planDecisions = retainedPlanDecisions.get(conversationId) ?? [];
      subagentDirectories = retainedSubagentDirectories.get(conversationId) ?? [];
      actorSelection =
        retainedActorSelections.get(conversationId) ?? actorSelectionFor("all");
      turns = retainedTurns.get(conversationId) ?? [];
      draft = retainedDrafts.get(conversationId) ?? "";
      pending = retainedPendingConversations.has(conversationId);
      questionIndex = 0;
      questionSelections = [];
      collectedQuestionAnswers = [];
      answeringQuestion = false;
      historyOwnsRoute = false;
      model = retainedModels.get(conversationId) ?? agentChatDefaults.model;
      reasoningEffort = retainedReasoningEfforts.get(conversationId)
        ?? agentChatDefaults.reasoningEffort;
      harnessMode = retainedHarnessModes.get(conversationId) ?? agentChatDefaults.harnessMode;
      providerInstanceId = retainedProviderInstances.get(conversationId)
        ?? agentChatDefaults.providerInstanceId;
      providerInstanceRevision = retainedProviderInstanceRevisions.get(conversationId) ?? "";
      protocolFacadeId = retainedProtocolFacades.get(conversationId) ?? "";
      providerId = retainedProviderIds.get(conversationId) ?? agentChatDefaults.providerId;
      if (projectId) {
        void hydrateProviderCatalogue();
        void hydrateHistory(projectId, conversationId);
      }
    }
  });

  $effect(() => {
    const defaults = agentChatDefaults;
    if (
      activeConversationId === conversationId
      && !historyOwnsRoute
      && !retainedModels.has(conversationId)
      && !retainedReasoningEfforts.has(conversationId)
      && !retainedHarnessModes.has(conversationId)
    ) {
      model = defaults.model;
      reasoningEffort = defaults.reasoningEffort;
      harnessMode = defaults.harnessMode;
      providerInstanceId = defaults.providerInstanceId;
      providerId = defaults.providerId;
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
    const unlisten = listen<AgentChatSubagentDirectory>(
      "agent-chat:subagents",
      ({ payload }) => {
        if (payload.conversation_id !== conversationId) {
          return;
        }
        subagentDirectories = [
          ...subagentDirectories.filter(
            (directory) =>
              directory.runtime_operation_id !== payload.runtime_operation_id,
          ),
          payload,
        ].sort(
          (left, right) =>
            left.turn_ordinal - right.turn_ordinal ||
            left.first_sequence - right.first_sequence,
        );
        retain(retainedSubagentDirectories, conversationId, subagentDirectories);
      },
    );
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
      planDecisions = history.plan_decisions;
      subagentDirectories = history.subagent_directories;
      actorSelection = history.actor_selection;
      turns = history.turns.map((turn) => ({
        turnId: turn.turn_id,
        status: turn.status,
        failureReason: turn.failure_reason,
      }));
      historyOwnsRoute = Boolean(
        history.provider_instance_id || history.model || history.reasoning_effort || history.harness_mode,
      );
      retain(retainedMessages, nextConversationId, messages);
      retain(retainedActivities, nextConversationId, activities);
      retain(retainedQuestions, nextConversationId, questions);
      retain(retainedPlanDecisions, nextConversationId, planDecisions);
      retain(retainedSubagentDirectories, nextConversationId, subagentDirectories);
      retain(retainedActorSelections, nextConversationId, actorSelection);
      retain(retainedTurns, nextConversationId, turns);
      model = history.model ?? model;
      providerInstanceId = history.provider_instance_id ?? providerInstanceId;
      providerInstanceRevision = history.provider_instance_revision
        ?? providerInstanceRevision;
      protocolFacadeId = history.protocol_facade_id ?? protocolFacadeId;
      providerId = history.provider_id ?? providerId;
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
      if (history.provider_instance_id) {
        retain(retainedProviderInstances, nextConversationId, history.provider_instance_id);
      }
      if (history.provider_instance_revision) {
        retain(
          retainedProviderInstanceRevisions,
          nextConversationId,
          history.provider_instance_revision,
        );
      }
      if (history.protocol_facade_id) {
        retain(retainedProtocolFacades, nextConversationId, history.protocol_facade_id);
      }
      retain(retainedProviderIds, nextConversationId, history.provider_id);
      applySelectedProvider();
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

    onConversationActive?.();

    failure = null;
    pending = true;
    cancelRequested = false;
    retainedPendingConversations.add(conversationId);
    setDraft("");
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
        provider_instance_id: providerInstanceId || null,
        provider_instance_revision: providerInstanceRevision || null,
        protocol_facade_id: protocolFacadeId || null,
        provider_id: providerId,
        model,
        reasoning_effort: reasoningEffort,
        harness_mode: harnessMode,
      });
      model = reply.model;
      providerInstanceId = reply.provider_instance_id;
      providerInstanceRevision = reply.provider_instance_revision;
      protocolFacadeId = reply.protocol_facade_id;
      providerId = reply.provider_id;
      retain(retainedProviderInstances, conversationId, providerInstanceId);
      retain(
        retainedProviderInstanceRevisions,
        conversationId,
        providerInstanceRevision,
      );
      retain(retainedProtocolFacades, conversationId, protocolFacadeId);
      retain(retainedProviderIds, conversationId, providerId);
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
      if (reply.assistant_message !== null) {
        appendMessage({
          id: `message:${reply.timeline_turn_id}:assistant`,
          turnId: reply.timeline_turn_id,
          sequence: nextMessageSequence(),
          role: "assistant",
          text: reply.assistant_message,
          taskReceipts: reply.task_receipts,
          workflowReceipts: reply.workflow_receipts,
        });
      }
      if (reply.task_receipts.length > 0 || reply.workflow_receipts.length > 0) {
        window.dispatchEvent(
          new CustomEvent("nucleus:tasks-changed", { detail: { projectId } }),
        );
      }
      window.dispatchEvent(new CustomEvent("nucleus:threads-changed"));
      if (pendingPlan) {
        // The server settled the pending plan as revised when this ordinary
        // message started; mirror that durable truth without a re-fetch.
        const settled = pendingPlan;
        planDecisions = planDecisions.map((candidate) =>
          candidate.turn_id === settled.turn_id
            ? { ...candidate, status: "revised" as const, decided_at_unix_ms: Date.now() }
            : candidate,
        );
        retain(retainedPlanDecisions, conversationId, planDecisions);
      }
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      if (!cancelRequested) {
        messages = messages.filter((message) => message.id !== optimisticMessageId);
        retain(retainedMessages, conversationId, messages);
        // An operator-cancelled turn is recorded by the transcript's terminal
        // item; it is not an error and gets no red banner.
        failure = reason;
      }
      await hydrateHistory(projectId, conversationId);
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
      setDraft("");
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
      setDraft("");
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

  function focusComposerEditor(): void {
    composerRegion?.querySelector("textarea")?.focus();
  }

  async function decidePlan(decision: "accepted" | "dismissed"): Promise<void> {
    if (!projectId || !pendingPlan || decidingPlan || pending) {
      return;
    }
    const plan = pendingPlan;
    decidingPlan = true;
    failure = null;
    if (decision === "accepted") {
      pending = true;
      cancelRequested = false;
      retainedPendingConversations.add(conversationId);
    }
    try {
      const reply = await decideAgentChatPlan({
        project_id: projectId,
        conversation_id: conversationId,
        turn_id: plan.turn_id,
        runtime_operation_id: plan.runtime_operation_id,
        activity_id: plan.activity_id,
        decision,
      });
      planDecisions = [
        ...planDecisions.filter((candidate) => candidate.turn_id !== plan.turn_id),
        reply.decision,
      ];
      retain(retainedPlanDecisions, conversationId, planDecisions);
      if (reply.follow_up) {
        harnessMode = reply.follow_up.harness_mode;
        retain(retainedHarnessModes, conversationId, reply.follow_up.harness_mode);
        await hydrateHistory(projectId, conversationId);
        window.dispatchEvent(new CustomEvent("nucleus:threads-changed"));
      }
    } catch (caught) {
      await hydrateHistory(projectId, conversationId);
      if (!cancelRequested) {
        failure = caught instanceof Error ? caught.message : String(caught);
      }
    } finally {
      if (decision === "accepted") {
        retainedPendingConversations.delete(conversationId);
        pending = false;
        cancelRequested = false;
      }
      decidingPlan = false;
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

  async function hydrateProviderCatalogue(): Promise<void> {
    if (retainedProviderCatalogue) {
      providerCatalogue = retainedProviderCatalogue;
      applySelectedProvider();
      return;
    }
    providerCatalogueRequest ??= loadAgentChatProviderCatalogue();
    try {
      retainedProviderCatalogue = await providerCatalogueRequest;
      providerCatalogue = retainedProviderCatalogue;
      applySelectedProvider();
    } catch {
      providerCatalogueRequest = null;
    }
  }

  function applySelectedProvider(): void {
    const ready = providerCatalogue.instances.filter(
      (instance) => instance.selection_readiness === "ready",
    );
    const selected = providerCatalogue.instances.find(
      (instance) => instance.provider_instance_id === providerInstanceId,
    ) ?? (ready.length === 1 ? ready[0] : null);
    if (!selected) {
      modelCatalog = [];
      return;
    }
    providerInstanceId = selected.provider_instance_id;
    providerInstanceRevision = selected.instance_revision;
    protocolFacadeId = selected.protocol_facade_id;
    modelCatalog = selected.models;
    const selectedModel = modelCatalog.find(
      (option) => option.model === model && option.provider_id === providerId,
    ) ?? modelCatalog.find((option) => option.model === model);
    if (!selectedModel && modelCatalog.length > 0) {
      model = modelCatalog[0].model;
      providerId = modelCatalog[0].provider_id;
      reasoningEffort = modelCatalog[0].default_reasoning_effort;
    } else if (selectedModel) {
      providerId = selectedModel.provider_id;
    }
  }

  function selectProviderInstance(value: string): void {
    providerInstanceId = value;
    applySelectedProvider();
    retain(retainedProviderInstances, conversationId, providerInstanceId);
    retain(retainedProviderInstanceRevisions, conversationId, providerInstanceRevision);
    retain(retainedProtocolFacades, conversationId, protocolFacadeId);
    retain(retainedProviderIds, conversationId, providerId);
    retain(retainedModels, conversationId, model);
    retain(retainedReasoningEfforts, conversationId, reasoningEffort);
  }

  function selectModelRoute(selection: ModelSelection): void {
    const selected = modelCatalog.find(
      (option) => modelRouteKey(option) === selection.model,
    );
    const nextModel = selected?.model ?? selection.model;
    model = nextModel;
    retain(retainedModels, conversationId, model);
    providerId = selected?.provider_id ?? null;
    retain(retainedProviderIds, conversationId, providerId);
    const selectedEffort = selection.axes.reasoning;
    reasoningEffort =
      typeof selectedEffort === "string"
        ? selectedEffort
        : selected?.default_reasoning_effort ?? DEFAULT_REASONING_EFFORT;
    retain(retainedReasoningEfforts, conversationId, reasoningEffort);
  }

  function selectHarnessMode(nextMode: string): void {
    harnessMode = nextMode === "plan" ? "plan" : DEFAULT_HARNESS_MODE;
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

  async function chooseActor(value: string): Promise<void> {
    const choice = actorChoices.find((candidate) => candidate.value === value);
    if (!projectId || !choice || selectionValue(choice.selection) === actorSelectionValue) {
      return;
    }
    const previous = actorSelection;
    actorSelection = choice.selection;
    retain(retainedActorSelections, conversationId, actorSelection);
    failure = null;
    try {
      actorSelection = await selectAgentChatActor(choice.selection);
      retain(retainedActorSelections, conversationId, actorSelection);
    } catch (caught) {
      actorSelection = previous;
      retain(retainedActorSelections, conversationId, actorSelection);
      failure = caught instanceof Error ? caught.message : String(caught);
    }
  }

  function actorSelectionFor(kind: "all" | "primary"): AgentChatActorSelection {
    return {
      project_id: projectId ?? "",
      conversation_id: conversationId,
      kind,
      runtime_operation_id: null,
      actor_id: null,
    };
  }

  function selectionValue(selection: AgentChatActorSelection): string {
    return selection.kind === "subagent" && selection.runtime_operation_id && selection.actor_id
      ? childSelectionValue(selection.runtime_operation_id, selection.actor_id)
      : selection.kind;
  }

  function childSelectionValue(operationId: string, actorId: string): string {
    return JSON.stringify([operationId, actorId]);
  }

  function childSelectionLabel(
    directory: AgentChatSubagentDirectory,
    subagent: AgentChatSubagentDirectory["subagents"][number],
  ): string {
    const name = subagent.label ?? subagent.subagent_id;
    const uncertainty = [
      subagent.status === "unknown" ? "status unknown" : subagent.status,
      subagent.parent_kind === "unknown" ? "parent unknown" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const operation = subagentDirectories.length > 1 ? ` · turn ${directory.turn_ordinal}` : "";
    return `${name} · ${uncertainty}${operation}`;
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
        {#if subagentDirectories.length > 0}
          <div class="actor-navigation">
            <Text tone="muted" size="xs">Transcript</Text>
            <Select
              value={actorSelectionValue}
              options={actorOptions}
              variant="ghost"
              size="xs"
              native={false}
              menuMinWidth="14rem"
              ariaLabel="Attributed agent work"
              onValueChange={(value) => void chooseActor(value)}
            />
          </div>
        {/if}
        <div class="transcript-content">
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

  <div class="composer-float" bind:this={composerRegion}>
    {#if failedTurnNotice}
      <div class="chat-error">Turn failed: {failedTurnNotice}</div>
    {/if}
    {#if failure}<div class="chat-error" role="alert">{failure}</div>{/if}
    {#key appliedDraftRequestId}
      <AgentChatInput
        bind:value={draft}
        placeholder={projectId ? "Ask Nucleus anything" : "Select a project first"}
        ariaLabel="Message Codex"
        submitLabel="Send message"
        minRows={2}
        maxRows={8}
        size="sm"
        status={pendingQuestion ? "questioning" : pending ? "busy" : pendingPlan ? "reviewing-plan" : "idle"}
        questionCanSubmit={questionCanSubmit}
        attachments={contextAttachments}
        disabled={!projectId || loadingHistory || answeringQuestion}
        onSubmit={submitComposer}
        onStop={() => void cancelTurn()}
        onValueChange={retainDraft}
        onRemoveAttachment={removeContextAttachment}
      >
        {#snippet plan()}
          {#if pendingPlan}
            <AgentPlan
              plan={pendingPlan.plan}
              dismissible
              size="sm"
              density="compact"
              onAccept={() => void decidePlan("accepted")}
              onRevise={focusComposerEditor}
              onDismiss={() => void decidePlan("dismissed")}
            />
          {/if}
        {/snippet}
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
          <div class="chat-route-controls">
            {#if shouldShowProviderSelector(providerCatalogue)}
              <Select
                value={providerInstanceId}
                options={providerOptions}
                variant="ghost"
                size="sm"
                native={false}
                ariaLabel="Agent provider"
                disabled={pending || loadingHistory}
                onValueChange={selectProviderInstance}
              />
            {/if}
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
            <Button
              variant="ghost"
              size="sm"
              pressed={harnessMode === "plan"}
              ariaLabel={`Harness mode: ${harnessMode === "plan" ? "Plan" : "Normal"}`}
              disabled={pending || loadingHistory}
              onPressedChange={(pressed) => selectHarnessMode(pressed ? "plan" : "normal")}
            >
              {harnessMode === "plan" ? "Plan" : "Normal"}
            </Button>
          </div>
        {/snippet}
      </AgentChatInput>
    {/key}
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
    container-name: agent-chat-panel;
    container-type: inline-size;
  }

  .chat-route-controls {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
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
    padding: 0;
  }

  /* Composer clearance lives inside the scroll region: the transcript
     stretches the full panel height and the last block scrolls above the
     floating composer, instead of the container reserving dead space. */
  .transcript-content :global(.poodle-agent-transcript__viewport) {
    padding-bottom: clamp(9rem, 18vh, 10.5rem);
  }

  /* The scroller spans the panel so the scrollbar rides the viewport edge;
     the reading column clamps the blocks, not the scroll container. */
  .transcript-content :global(.poodle-agent-transcript__runway),
  .transcript-content :global(.poodle-agent-transcript__blocks) {
    width: min(48rem, 100%);
    margin: 0 auto;
  }

  /* The activity strip ("Working…") lives outside the scroller; clamp it to
     the same column, inset included. */
  .transcript-content :global(.poodle-agent-transcript__activity) {
    box-sizing: border-box;
    width: min(48rem, 100%);
    margin-right: auto;
    margin-left: auto;
    padding-inline: var(--poodle-agent-transcript-inset);
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
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-height: 0;
  }

  .actor-navigation {
    position: relative;
    z-index: 6;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
    width: min(48rem, 100%);
    min-height: 2rem;
    margin: 0 auto;
    padding-bottom: 0.35rem;
  }

  .transcript-content {
    min-height: 0;
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

  .composer-float {
    position: absolute;
    z-index: 5;
    right: clamp(0.75rem, 3cqi, 2rem);
    bottom: clamp(0.75rem, 2cqi, 1.35rem);
    left: clamp(0.75rem, 3cqi, 2rem);
    display: grid;
    gap: 0.45rem;
    width: min(48rem, calc(100% - clamp(1.5rem, 6cqi, 4rem)));
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

  /* Narrow panels wrap the composer's model row taller, so the scroll-region
     clearance grows to match. */
  @container agent-chat-panel (max-width: 36rem) {
    .transcript-content :global(.poodle-agent-transcript__viewport) {
      padding-bottom: 12rem;
    }
  }
</style>
