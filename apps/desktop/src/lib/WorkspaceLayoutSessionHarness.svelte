<script lang="ts">
  import {
    WorkspaceLayoutSession,
    type WorkspaceLayoutPort,
  } from "./workspaceLayout.svelte";

  let {
    projectId,
    port,
    onSession,
  }: {
    projectId: string;
    port: WorkspaceLayoutPort;
    onSession?: (session: WorkspaceLayoutSession) => void;
  } = $props();

  let session = $state<WorkspaceLayoutSession>();

  $effect(() => {
    const active = new WorkspaceLayoutSession({ projectId, port });
    session = active;
    onSession?.(active);
    void active.start();
    return () => {
      void active.destroy();
    };
  });
</script>

<output data-testid="project">
  {session?.snapshot?.project_id ?? session?.status.kind ?? "idle"}
</output>
