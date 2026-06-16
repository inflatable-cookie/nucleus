<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { send } from "@poodle/icons-lucide";
  import {
    buildRuntimeMetadataQuery,
    buildStateListQuery,
    CONTROL_PROTOCOL_FAMILY,
    CONTROL_PROTOCOL_VERSION,
    submitControlEnvelope,
    type ControlResponseEnvelopeDto,
    type ControlRequestEnvelopeDto,
  } from "./control";

  type DiagnosticQueryOption = {
    id: string;
    label: string;
    buildRequest: () => ControlRequestEnvelopeDto;
  };

  const queryOptions: DiagnosticQueryOption[] = [
    {
      id: "artifact-metadata",
      label: "Artifact metadata",
      buildRequest: () => buildRuntimeMetadataQuery("list_artifact_metadata"),
    },
    {
      id: "command-evidence",
      label: "Command evidence",
      buildRequest: () => buildRuntimeMetadataQuery("list_command_evidence"),
    },
    {
      id: "projects",
      label: "Projects",
      buildRequest: () => buildStateListQuery("projects"),
    },
    {
      id: "tasks",
      label: "Tasks",
      buildRequest: () => buildStateListQuery("tasks"),
    },
    {
      id: "workspaces",
      label: "Workspaces",
      buildRequest: () => buildStateListQuery("workspaces"),
    },
  ];

  let pending = $state(false);
  let response = $state<ControlResponseEnvelopeDto | null>(null);
  let failure = $state<string | null>(null);
  let lastRequestId = $state<string | null>(null);
  let selectedQueryId = $state(queryOptions[0].id);

  const selectedQuery = $derived(
    queryOptions.find((option) => option.id === selectedQueryId) ?? queryOptions[0],
  );

  const statusLabel = $derived(
    pending ? "running" : failure ? "error" : (response?.status ?? "idle"),
  );
  const statusTone = $derived(
    pending ? "pending" : failure ? "danger" : response?.status === "complete" ? "success" : "neutral",
  );

  async function runProbe() {
    pending = true;
    failure = null;

    const request = selectedQuery.buildRequest();
    lastRequestId = request.request_id;

    try {
      response = await submitControlEnvelope(request);
    } catch (error) {
      response = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      pending = false;
    }
  }
</script>

<Surface>
  <section class="diagnostics-panel" aria-label="Control Diagnostics">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Control diagnostics</h2>
        <Text tone="muted">
          Checks the desktop command path through the Rust server boundary.
        </Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    <dl class="diagnostic-grid">
      <div>
        <dt>Protocol</dt>
        <dd>{CONTROL_PROTOCOL_FAMILY}</dd>
      </div>
      <div>
        <dt>Version</dt>
        <dd>{CONTROL_PROTOCOL_VERSION}</dd>
      </div>
      <div>
        <dt>Last request</dt>
        <dd>{lastRequestId ?? "none"}</dd>
      </div>
      <div>
        <dt>Query</dt>
        <dd>{selectedQuery.label}</dd>
      </div>
    </dl>

    <div class="query-options" aria-label="Control query options">
      {#each queryOptions as option}
        <Button
          variant={option.id === selectedQueryId ? "primary" : "secondary"}
          onClick={() => (selectedQueryId = option.id)}
          disabled={pending}
        >
          {option.label}
        </Button>
      {/each}
    </div>

    <div class="panel-actions">
      <Button variant="primary" leadingIcon={send} onClick={runProbe} disabled={pending}>
        {pending ? "Sending" : "Run query"}
      </Button>
    </div>

    {#if response}
      <pre class="output">{JSON.stringify(response, null, 2)}</pre>
    {:else if failure}
      <pre class="output error">{failure}</pre>
    {:else}
      <pre class="output">No command response yet.</pre>
    {/if}
  </section>
</Surface>
