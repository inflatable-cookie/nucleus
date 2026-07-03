<script lang="ts">
  import { StatusIndicator, Text } from "@poodle/svelte";
  import CommandDiagnosticsPanel from "./lib/CommandDiagnosticsPanel.svelte";
  import ControlDiagnosticsPanel from "./lib/ControlDiagnosticsPanel.svelte";
  import DiagnosticsProofPanel from "./lib/DiagnosticsProofPanel.svelte";
  import ProviderReadinessOverviewPanel from "./lib/ProviderReadinessOverviewPanel.svelte";
  import PlanningResearchProofPanel from "./lib/PlanningResearchProofPanel.svelte";
  import ProjectSwitcherPanel from "./lib/ProjectSwitcherPanel.svelte";
  import RuntimeReadinessPanel from "./lib/RuntimeReadinessPanel.svelte";
  import TaskDetailPanel from "./lib/TaskDetailPanel.svelte";
  import TaskListPanel from "./lib/TaskListPanel.svelte";
  import TaskWorkProgressPanel from "./lib/TaskWorkProgressPanel.svelte";
  import type { ControlTaskRecordDto } from "./lib/control";

  let selectedProjectId = $state<string | null>(null);
  let selectedTaskId = $state<string | null>(null);
  let selectedTask = $state<ControlTaskRecordDto | null>(null);
  let taskRefreshToken = $state(0);
</script>

<main class="shell" data-theme="dark" data-density="compact" data-control-size="sm">
  <aside class="sidebar" aria-label="Projects">
    <div class="brand">Nucleus</div>
    <nav>
      <a class="active" href="/">Control</a>
      <a href="/">Projects</a>
      <a href="/">Tasks</a>
    </nav>
  </aside>

  <section class="workspace" aria-label="Desktop Shell">
    <header class="topbar">
      <div>
        <h1>Desktop shell</h1>
        <Text tone="muted">Read-only Rust control plane</Text>
      </div>
      <StatusIndicator status="info" label="local" />
    </header>

    <div class="panel-grid">
      <ProjectSwitcherPanel bind:selectedProjectId />
      <TaskListPanel
        {selectedProjectId}
        {taskRefreshToken}
        bind:selectedTaskId
        bind:selectedTask
      />
      <TaskDetailPanel
        {selectedTask}
        onTaskChanged={() => {
          taskRefreshToken += 1;
        }}
      />
      <RuntimeReadinessPanel />
      <TaskWorkProgressPanel />
      <PlanningResearchProofPanel />
      <ProviderReadinessOverviewPanel />
      <CommandDiagnosticsPanel />
      <DiagnosticsProofPanel />
      <ControlDiagnosticsPanel />
    </div>
  </section>
</main>
