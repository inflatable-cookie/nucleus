<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import {
    buildArchiveTaskCommand,
    buildBlockTaskCommand,
    buildCompleteTaskCommand,
    buildStartTaskCommand,
    submitControlEnvelope,
    type ControlRequestEnvelopeDto,
    type ControlTaskRecordDto,
  } from "./control";

  type Props = {
    selectedTask: ControlTaskRecordDto | null;
    onTaskChanged?: () => void;
  };

  let { selectedTask, onTaskChanged }: Props = $props();
  let pending = $state(false);
  let blockReason = $state("");
  let commandMessage = $state<string | null>(null);
  let failure = $state<string | null>(null);

  const statusLabel = $derived(selectedTask ? selectedTask.activity : "none");
  const statusTone = $derived(pending ? "pending" : selectedTask ? "info" : "neutral");

  async function submitTaskCommand(buildRequest: () => ControlRequestEnvelopeDto) {
    pending = true;
    commandMessage = null;
    failure = null;

    try {
      const response = await submitControlEnvelope(buildRequest());
      if (response.body.type === "command_receipt") {
        commandMessage = `${response.body.command_id}: ${response.body.status}`;
        if (response.body.status !== "rejected") {
          onTaskChanged?.();
        }
      } else if (response.body.type === "error") {
        failure = `${response.body.kind}: ${response.body.reason}`;
      } else {
        failure = `Unexpected response: ${response.body.type}`;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      pending = false;
    }
  }

  function submitStart() {
    if (selectedTask) {
      void submitTaskCommand(() => buildStartTaskCommand(selectedTask));
    }
  }

  function submitBlock() {
    if (selectedTask) {
      void submitTaskCommand(() => buildBlockTaskCommand(selectedTask, blockReason.trim()));
    }
  }

  function submitComplete() {
    if (selectedTask) {
      void submitTaskCommand(() => buildCompleteTaskCommand(selectedTask));
    }
  }

  function submitArchive() {
    if (selectedTask) {
      void submitTaskCommand(() => buildArchiveTaskCommand(selectedTask));
    }
  }
</script>

<Surface>
  <section class="task-detail-panel" aria-label="Task Detail">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Task detail</h2>
        <Text tone="muted">Read-only selected task DTO.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if selectedTask}
      <div class="task-detail-summary">
        <h3>{selectedTask.title}</h3>
        {#if selectedTask.description}
          <Text tone="muted">{selectedTask.description}</Text>
        {:else}
          <Text tone="muted">No description.</Text>
        {/if}
      </div>

      <dl class="task-detail-grid">
        <div>
          <dt>Project</dt>
          <dd>{selectedTask.project_id}</dd>
        </div>
        <div>
          <dt>Task</dt>
          <dd>{selectedTask.task_id}</dd>
        </div>
        <div>
          <dt>Action</dt>
          <dd>{selectedTask.action_type}</dd>
        </div>
        <div>
          <dt>Importance</dt>
          <dd>{selectedTask.importance}</dd>
        </div>
        <div>
          <dt>Assignment</dt>
          <dd>{selectedTask.assignment_intent ?? "unassigned"}</dd>
        </div>
        <div>
          <dt>Agent readiness</dt>
          <dd>{selectedTask.agent_ready ? "ready" : "not ready"}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>{selectedTask.revision_id}</dd>
        </div>
      </dl>

      <div class="task-transition-controls" aria-label="Task Transitions">
        <div class="block-reason-field">
          <label for="block-reason">Block reason</label>
          <input
            id="block-reason"
            type="text"
            bind:value={blockReason}
            placeholder="Reason"
            disabled={pending}
          />
        </div>
        <div class="task-transition-buttons">
          <Button variant="secondary" onClick={submitStart} disabled={pending}>Start</Button>
          <Button variant="secondary" onClick={submitBlock} disabled={pending || !blockReason.trim()}>
            Block
          </Button>
          <Button variant="secondary" onClick={submitComplete} disabled={pending}>Complete</Button>
          <Button variant="secondary" onClick={submitArchive} disabled={pending}>Archive</Button>
        </div>
      </div>

      {#if failure}
        <div class="panel-message panel-message-error">
          <Text tone="danger">{failure}</Text>
        </div>
      {:else if commandMessage}
        <div class="panel-message">
          <Text tone="muted">{commandMessage}</Text>
        </div>
      {/if}
    {:else}
      <div class="panel-message">
        <Text tone="muted">No task selected.</Text>
      </div>
    {/if}
  </section>
</Surface>
