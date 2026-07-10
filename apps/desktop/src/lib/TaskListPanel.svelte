<script lang="ts">
  import { onMount } from "svelte";
  import { IconButton, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    buildStateListQuery,
    goalRecordsFromResponse,
    submitControlEnvelope,
    taskRecordsFromResponse,
    type ControlGoalRecordDto,
    type ControlTaskRecordDto,
  } from "./control";

  let {
    selectedProjectId,
    taskRefreshToken = 0,
    selectedGoalId = $bindable(null),
    selectedGoal = $bindable(null),
    selectedTaskId = $bindable(null),
    selectedTask = $bindable(null),
  }: {
    selectedProjectId: string | null;
    taskRefreshToken?: number;
    selectedGoalId: string | null;
    selectedGoal?: ControlGoalRecordDto | null;
    selectedTaskId: string | null;
    selectedTask?: ControlTaskRecordDto | null;
  } = $props();

  let loading = $state(false);
  let goals = $state<ControlGoalRecordDto[]>([]);
  let tasks = $state<ControlTaskRecordDto[]>([]);
  let failure = $state<string | null>(null);

  const visibleGoals = $derived(
    goals
      .filter((goal) => !selectedProjectId || goal.project_id === selectedProjectId)
      .sort((left, right) => left.title.localeCompare(right.title)),
  );
  const visibleTasks = $derived(
    tasks.filter((task) => !selectedProjectId || task.project_id === selectedProjectId),
  );
  const taskById = $derived(new Map(visibleTasks.map((task) => [task.task_id, task])));
  const goalGroups = $derived(
    visibleGoals.map((goal) => {
      const groupTasks = goal.ordered_task_refs
        .map((taskId) => taskById.get(taskId))
        .filter((task): task is ControlTaskRecordDto => Boolean(task));
      return {
        goal,
        tasks: groupTasks,
        doneCount: groupTasks.filter((task) => task.activity === "done").length,
      };
    }),
  );
  const groupedTaskIds = $derived(
    new Set(visibleGoals.flatMap((goal) => goal.ordered_task_refs)),
  );
  const ungroupedTasks = $derived(
    visibleTasks
      .filter((task) => !groupedTaskIds.has(task.task_id))
      .sort((left, right) => left.title.localeCompare(right.title)),
  );
  const selectedGoalRecord = $derived(
    visibleGoals.find((goal) => goal.goal_id === selectedGoalId) ?? null,
  );
  const selectedTaskRecord = $derived(
    visibleTasks.find((task) => task.task_id === selectedTaskId) ?? null,
  );
  const taskAdvancedFieldCount = $derived(
    selectedTaskRecord
      ? selectedTaskRecord.required_context_refs.length +
          selectedTaskRecord.stop_conditions.length +
          selectedTaskRecord.validation_commands.length
      : 0,
  );
  const selectedGoalDoneCount = $derived(
    selectedGoalRecord
      ? selectedGoalRecord.ordered_task_refs.filter(
          (taskId) => taskById.get(taskId)?.activity === "done",
        ).length
      : 0,
  );

  $effect(() => {
    selectedProjectId;
    taskRefreshToken;
    void loadWork();
  });

  $effect(() => {
    selectedGoal = selectedGoalRecord;
    selectedTask = selectedTaskRecord;
  });

  onMount(() => {
    const refreshAfterAuthoring = (event: Event) => {
      const changedProjectId = (event as CustomEvent<{ projectId: string }>).detail.projectId;
      if (!selectedProjectId || changedProjectId === selectedProjectId) {
        void loadWork();
      }
    };
    window.addEventListener("nucleus:tasks-changed", refreshAfterAuthoring);
    return () => window.removeEventListener("nucleus:tasks-changed", refreshAfterAuthoring);
  });

  async function loadWork(): Promise<void> {
    loading = true;
    failure = null;
    try {
      const [taskResponse, goalResponse] = await Promise.all([
        submitControlEnvelope(buildStateListQuery("tasks")),
        submitControlEnvelope(buildStateListQuery("goals")),
      ]);
      tasks = taskRecordsFromResponse(taskResponse);
      goals = goalRecordsFromResponse(goalResponse);
      if (selectedTaskId && !tasks.some((task) => task.task_id === selectedTaskId)) {
        selectedTaskId = null;
      }
      if (selectedGoalId && !goals.some((goal) => goal.goal_id === selectedGoalId)) {
        selectedGoalId = null;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function selectGoal(goalId: string): void {
    selectedGoalId = goalId;
    selectedTaskId = null;
  }

  function selectTask(taskId: string, goalId: string | null): void {
    selectedGoalId = goalId;
    selectedTaskId = taskId;
  }
</script>

<section class="tasks-panel" aria-label="Tasks">
  <header class="tasks-header">
    <div>
      <h1>Tasks</h1>
      <Text size="sm" tone="muted">
        {visibleGoals.length} {visibleGoals.length === 1 ? "goal" : "goals"} · {visibleTasks.length} {visibleTasks.length === 1 ? "task" : "tasks"}
      </Text>
    </div>
    <IconButton
      variant="ghost"
      size="sm"
      icon={refreshCw}
      ariaLabel="Refresh goals and tasks"
      tooltip="Refresh goals and tasks"
      onClick={loadWork}
      disabled={loading}
    />
  </header>

  {#if failure}
    <div class="panel-message panel-error" role="alert">{failure}</div>
  {:else if loading && tasks.length === 0 && goals.length === 0}
    <div class="panel-message"><Text tone="muted">Loading work…</Text></div>
  {:else if visibleTasks.length === 0 && visibleGoals.length === 0}
    <div class="panel-message">
      <Text weight="semibold">No work yet</Text>
      <Text tone="muted">Ask the agent to shape a goal and its first tasks.</Text>
    </div>
  {:else}
    <div class="tasks-body">
      <nav class="task-list" aria-label="Project goals and tasks">
        {#each goalGroups as group (group.goal.goal_id)}
          <section class="goal-group">
            <button
              type="button"
              class="goal-row"
              class:selected={group.goal.goal_id === selectedGoalId}
              onclick={() => selectGoal(group.goal.goal_id)}
            >
              <span class="goal-title">{group.goal.title}</span>
              <span class="goal-meta">
                {group.goal.status} · {group.doneCount}/{group.goal.ordered_task_refs.length}
              </span>
            </button>
            {#each group.tasks as task (task.task_id)}
              <button
                type="button"
                class="task-row nested"
                class:selected={task.task_id === selectedTaskId && group.goal.goal_id === selectedGoalId}
                onclick={() => selectTask(task.task_id, group.goal.goal_id)}
              >
                <span class="task-title">{task.title}</span>
                <span class="task-meta">
                  <span class:ready={task.agent_ready} class="readiness-dot"></span>
                  {task.activity} · {task.action_type}
                </span>
              </button>
            {/each}
          </section>
        {/each}

        {#if ungroupedTasks.length > 0}
          <section class="goal-group ungrouped-group">
            <div class="ungrouped-heading">
              <span>Ungrouped</span><span>{ungroupedTasks.length}</span>
            </div>
            {#each ungroupedTasks as task (task.task_id)}
              <button
                type="button"
                class="task-row nested"
                class:selected={task.task_id === selectedTaskId && selectedGoalId === null}
                onclick={() => selectTask(task.task_id, null)}
              >
                <span class="task-title">{task.title}</span>
                <span class="task-meta">
                  <span class:ready={task.agent_ready} class="readiness-dot"></span>
                  {task.activity} · {task.action_type}
                </span>
              </button>
            {/each}
          </section>
        {/if}
      </nav>

      <article class="task-detail" aria-live="polite">
        {#if selectedTaskRecord}
          <div class="detail-heading">
            <div>
              <span class="eyebrow">{selectedTaskRecord.action_type}</span>
              <h2>{selectedTaskRecord.title}</h2>
              {#if selectedGoalRecord}
                <span class="parent-goal">{selectedGoalRecord.title}</span>
              {/if}
            </div>
            <span class="state-pill">{selectedTaskRecord.activity}</span>
          </div>

          {#if selectedTaskRecord.description}
            <p class="description">{selectedTaskRecord.description}</p>
          {:else}
            <Text tone="muted">No description recorded.</Text>
          {/if}

          <dl class="task-facts">
            <div><dt>Importance</dt><dd>{selectedTaskRecord.importance}</dd></div>
            <div><dt>Agent</dt><dd>{selectedTaskRecord.agent_ready ? "Ready" : "Not ready"}</dd></div>
            <div><dt>Assignment</dt><dd>{selectedTaskRecord.assignment_intent ?? "Unassigned"}</dd></div>
          </dl>

          <section class="detail-section">
            <h3>Acceptance</h3>
            {#if selectedTaskRecord.acceptance_criteria.length > 0}
              <ul class="acceptance-list">
                {#each selectedTaskRecord.acceptance_criteria as criterion}<li>{criterion.text}</li>{/each}
              </ul>
            {:else}
              <Text size="sm" tone="muted">No acceptance criteria recorded.</Text>
            {/if}
          </section>

          {#if selectedTaskRecord.blocked_reason}
            <section class="blocked-reason">
              <strong>Blocked</strong><span>{selectedTaskRecord.blocked_reason}</span>
            </section>
          {/if}

          <details class="advanced-detail">
            <summary>Advanced{taskAdvancedFieldCount ? ` · ${taskAdvancedFieldCount}` : ""}</summary>
            <div class="advanced-sections">
              {@render StringList("Required context", selectedTaskRecord.required_context_refs)}
              {@render StringList("Allowed actions", selectedTaskRecord.allowed_actions)}
              {@render StringList("Stop conditions", selectedTaskRecord.stop_conditions)}
              {@render StringList("Validation", selectedTaskRecord.validation_commands)}
              <div><h4>Task ID</h4><code>{selectedTaskRecord.task_id}</code></div>
            </div>
          </details>
        {:else if selectedGoalRecord}
          <div class="detail-heading">
            <div><span class="eyebrow">Goal</span><h2>{selectedGoalRecord.title}</h2></div>
            <span class="state-pill">{selectedGoalRecord.status}</span>
          </div>
          <p class="description">{selectedGoalRecord.desired_outcome}</p>
          <dl class="task-facts">
            <div><dt>Progress</dt><dd>{selectedGoalDoneCount}/{selectedGoalRecord.ordered_task_refs.length} done</dd></div>
            <div><dt>Next</dt><dd>{selectedGoalRecord.next_action ?? "Not set"}</dd></div>
          </dl>
          <section class="detail-section">
            <h3>Scope</h3>
            <p class="detail-copy">{selectedGoalRecord.scope}</p>
          </section>
          {#if selectedGoalRecord.blocked_reason}
            <section class="blocked-reason">
              <strong>Blocked</strong><span>{selectedGoalRecord.blocked_reason}</span>
            </section>
          {/if}
          <details class="advanced-detail">
            <summary>Advanced</summary>
            <div class="advanced-sections">
              {@render StringList("Stop conditions", selectedGoalRecord.stop_conditions)}
              {@render StringList("Owners", selectedGoalRecord.owner_refs)}
              {@render StringList("Planning artifacts", selectedGoalRecord.planning_artifact_refs)}
              {@render StringList("Evidence", selectedGoalRecord.evidence_refs)}
              <div><h4>Goal ID</h4><code>{selectedGoalRecord.goal_id}</code></div>
              <div><h4>Revision</h4><code>{selectedGoalRecord.revision_id}</code></div>
            </div>
          </details>
        {:else}
          <div class="detail-empty">
            <Text weight="semibold">Select a goal or task</Text>
            <Text tone="muted">Details stay here, out of the main conversation.</Text>
          </div>
        {/if}
      </article>
    </div>
  {/if}
</section>

{#snippet StringList(label: string, values: string[])}
  {#if values.length > 0}
    <div><h4>{label}</h4><ul>{#each values as value}<li>{value}</li>{/each}</ul></div>
  {/if}
{/snippet}

<style>
  .tasks-panel { display: grid; grid-template-rows: auto minmax(0, 1fr); width: 100%; height: 100%; min-width: 0; min-height: 0; color: var(--poodle-color-text-primary); background: var(--poodle-color-background-canvas); }
  .tasks-header { display: flex; align-items: center; justify-content: space-between; padding: 0.8rem 1rem; border-bottom: 1px solid var(--poodle-color-border-subtle); }
  h1, h2, h3, h4, p { margin: 0; }
  h1 { font-size: 0.95rem; }
  h2 { font-size: 1.15rem; line-height: 1.3; }
  h3 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; }
  h4 { margin-bottom: 0.35rem; font-size: 0.75rem; color: var(--poodle-color-text-secondary); }
  .tasks-body { display: grid; grid-template-columns: minmax(14rem, 0.72fr) minmax(20rem, 1.28fr); min-height: 0; }
  .task-list { min-width: 0; overflow: auto; padding: 0.45rem; border-right: 1px solid var(--poodle-color-border-subtle); }
  .goal-group + .goal-group { margin-top: 0.4rem; padding-top: 0.4rem; border-top: 1px solid var(--poodle-color-border-subtle); }
  .goal-row, .task-row { display: grid; gap: 0.3rem; width: 100%; color: inherit; text-align: left; border: 0; border-radius: var(--poodle-radius-control); background: transparent; cursor: pointer; }
  .goal-row { padding: 0.65rem 0.7rem; }
  .task-row { padding: 0.55rem 0.7rem; }
  .task-row.nested { padding-left: 1.15rem; }
  .goal-row:hover, .task-row:hover { background: var(--poodle-color-background-surface); }
  .goal-row.selected { background: var(--poodle-color-background-surface); }
  .task-row.selected { background: var(--poodle-color-background-panel); box-shadow: inset 2px 0 var(--poodle-color-border-strong); }
  .goal-title, .task-title { font-size: 0.84rem; font-weight: 600; line-height: 1.35; }
  .goal-meta, .task-meta, .parent-goal { display: flex; align-items: center; gap: 0.35rem; color: var(--poodle-color-text-secondary); font-size: 0.72rem; }
  .ungrouped-heading { display: flex; justify-content: space-between; padding: 0.5rem 0.7rem 0.25rem; color: var(--poodle-color-text-secondary); font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .readiness-dot { width: 0.38rem; height: 0.38rem; border-radius: 50%; background: var(--poodle-color-text-tertiary); }
  .readiness-dot.ready { background: var(--poodle-color-status-success); }
  .task-detail { min-width: 0; overflow: auto; padding: clamp(1rem, 3vw, 2rem); }
  .detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .eyebrow { display: block; margin-bottom: 0.3rem; color: var(--poodle-color-text-secondary); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; }
  .parent-goal { margin-top: 0.3rem; }
  .state-pill { padding: 0.25rem 0.48rem; color: var(--poodle-color-text-secondary); font-size: 0.7rem; border: 1px solid var(--poodle-color-border-subtle); border-radius: 999px; }
  .description { max-width: 46rem; margin-top: 1rem; font-size: 0.88rem; line-height: 1.55; white-space: pre-wrap; }
  .detail-copy { max-width: 46rem; font-size: 0.84rem; line-height: 1.5; white-space: pre-wrap; }
  .task-facts { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 1.3rem 0 0; }
  .task-facts div { display: grid; gap: 0.2rem; }
  dt { color: var(--poodle-color-text-secondary); font-size: 0.7rem; }
  dd { margin: 0; font-size: 0.8rem; text-transform: capitalize; }
  .detail-section { display: grid; gap: 0.65rem; margin-top: 1.5rem; }
  .acceptance-list { display: grid; gap: 0.5rem; margin: 0; padding-left: 1.15rem; font-size: 0.84rem; line-height: 1.45; }
  .blocked-reason { display: grid; gap: 0.25rem; margin-top: 1.25rem; padding: 0.7rem; color: var(--poodle-color-status-danger); font-size: 0.8rem; border: 1px solid var(--poodle-color-status-danger); border-radius: var(--poodle-radius-control); }
  .advanced-detail { margin-top: 1.5rem; font-size: 0.8rem; }
  .advanced-detail summary { width: fit-content; color: var(--poodle-color-text-secondary); cursor: pointer; }
  .advanced-sections { display: grid; gap: 1rem; margin-top: 0.9rem; padding: 0.9rem; border: 1px solid var(--poodle-color-border-subtle); border-radius: var(--poodle-radius-control); }
  .advanced-sections ul { display: grid; gap: 0.25rem; margin: 0; padding-left: 1rem; overflow-wrap: anywhere; }
  code { color: var(--poodle-color-text-secondary); font-size: 0.72rem; overflow-wrap: anywhere; }
  .panel-message, .detail-empty { display: grid; place-content: center; justify-items: center; gap: 0.4rem; min-height: 100%; padding: 2rem; text-align: center; }
  .panel-error { color: var(--poodle-color-status-danger); }
  @media (max-width: 720px) { .tasks-body { grid-template-columns: minmax(11rem, 0.85fr) minmax(15rem, 1.15fr); } }
</style>
