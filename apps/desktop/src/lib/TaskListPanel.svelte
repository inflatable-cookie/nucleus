<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    buildStateListQuery,
    submitControlEnvelope,
    taskRecordsFromResponse,
    type ControlTaskRecordDto,
  } from "./control";

  type Props = {
    selectedProjectId: string | null;
    taskRefreshToken: number;
    selectedTaskId: string | null;
    selectedTask: ControlTaskRecordDto | null;
  };

  let {
    selectedProjectId,
    taskRefreshToken,
    selectedTaskId = $bindable(null),
    selectedTask = $bindable(null),
  }: Props = $props();
  let loading = $state(false);
  let tasks = $state<ControlTaskRecordDto[]>([]);
  let failure = $state<string | null>(null);

  const visibleTasks = $derived(
    selectedProjectId ? tasks.filter((task) => task.project_id === selectedProjectId) : tasks,
  );
  const statusLabel = $derived(
    loading
      ? "loading"
      : failure
        ? "error"
        : `${visibleTasks.length} task${visibleTasks.length === 1 ? "" : "s"}`,
  );
  const statusTone = $derived(loading ? "pending" : failure ? "danger" : "success");

  $effect(() => {
    if (
      selectedTaskId &&
      !visibleTasks.some((task) => task.task_id === selectedTaskId)
    ) {
      selectedTaskId = null;
    }
    selectedTask = visibleTasks.find((task) => task.task_id === selectedTaskId) ?? null;
  });

  async function loadTasks() {
    loading = true;
    failure = null;

    try {
      const response = await submitControlEnvelope(buildStateListQuery("tasks"));
      tasks = taskRecordsFromResponse(response);
    } catch (error) {
      tasks = [];
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    taskRefreshToken;
    void loadTasks();
  });
</script>

<Surface>
  <section class="task-list-panel" aria-label="Tasks">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Tasks</h2>
        <Text tone="muted">Read-only server-owned task records.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if failure}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{failure}</Text>
      </div>
    {:else if loading}
      <div class="panel-message">
        <Text tone="muted">Loading tasks.</Text>
      </div>
    {:else if visibleTasks.length === 0}
      <div class="panel-message">
        <Text tone="muted">
          {selectedProjectId ? "No tasks for selected project." : "No tasks available."}
        </Text>
      </div>
    {:else}
      <div class="task-list">
        {#each visibleTasks as task}
          <button
            class:selected={task.task_id === selectedTaskId}
            type="button"
            onclick={() => (selectedTaskId = task.task_id)}
          >
            <div>
              <h3>{task.title}</h3>
              <small>{task.project_id}</small>
            </div>
            <dl>
              <div>
                <dt>Activity</dt>
                <dd>{task.activity}</dd>
              </div>
              <div>
                <dt>Action</dt>
                <dd>{task.action_type}</dd>
              </div>
              <div>
                <dt>Importance</dt>
                <dd>{task.importance}</dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>{task.agent_ready ? "ready" : "not ready"}</dd>
              </div>
            </dl>
          </button>
        {/each}
      </div>
    {/if}

    <div class="panel-actions">
      <Text tone="muted">{selectedProjectId ?? "All projects"}</Text>
      <Button variant="secondary" leadingIcon={refreshCw} onClick={loadTasks} disabled={loading}>
        Refresh
      </Button>
    </div>
  </section>
</Surface>
