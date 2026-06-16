<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { send } from "@poodle/icons-lucide";
  import {
    buildArtifactMetadataProbe,
    submitControlEnvelope,
    type ControlResponseEnvelopeDto,
  } from "./lib/control";

  let pending = $state(false);
  let response = $state<ControlResponseEnvelopeDto | null>(null);
  let failure = $state<string | null>(null);

  async function probeControlCommand() {
    pending = true;
    failure = null;

    try {
      response = await submitControlEnvelope(buildArtifactMetadataProbe());
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      pending = false;
    }
  }
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
        <Text tone="muted">Tauri command path proof</Text>
      </div>
      <StatusIndicator status={response?.status === "complete" ? "success" : "neutral"} label={response?.status ?? "idle"} />
    </header>

    <div class="probe">
      <Surface>
        <div class="probe-body">
          <div class="probe-copy">
            <h2>Control command</h2>
            <Text tone="muted">
              Calls the Rust server adapter with a serialized envelope and renders the DTO response.
            </Text>
          </div>

          <Button variant="primary" leadingIcon={send} onClick={probeControlCommand} disabled={pending}>
            {pending ? "Sending" : "Send probe"}
          </Button>
        </div>
      </Surface>
    </div>

    {#if response}
      <pre class="output">{JSON.stringify(response, null, 2)}</pre>
    {:else if failure}
      <pre class="output error">{failure}</pre>
    {:else}
      <pre class="output">No command response yet.</pre>
    {/if}
  </section>
</main>
