<script lang="ts">
  import { StatusIndicator, Text } from "@poodle/svelte";
  import ControlDiagnosticsPanel from "./lib/ControlDiagnosticsPanel.svelte";
  import ProjectSwitcherPanel from "./lib/ProjectSwitcherPanel.svelte";

  let selectedProjectId = $state<string | null>(null);
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
      <ControlDiagnosticsPanel />
    </div>
  </section>
</main>
