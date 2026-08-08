<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import type { EventTransport } from "@inflatable-cookie/longhorn/core";
  import { ConfigOperationsClient } from "@inflatable-cookie/longhorn/config";
  import { BackupSettingsPage, StorageSettingsPage } from "@inflatable-cookie/longhorn-poodle-svelte/config/poodle";
  import NucleusRestoreSettingsPage from "./NucleusRestoreSettingsPage.svelte";

  let { rendererId }: { rendererId: string } = $props();
  const transport: EventTransport = {
    invoke: (command, arguments_) => invoke(command, arguments_),
    listen: async (event, listener) => {
      const unlisten = await listen<unknown>(event, ({ payload }) => listener(payload));
      return unlisten;
    },
  };
  const client = new ConfigOperationsClient(transport);
</script>

{#if rendererId === "longhorn:config.storage"}
  <StorageSettingsPage {client} />
{:else if rendererId === "longhorn:config.restore"}
  <NucleusRestoreSettingsPage />
{:else}
  <BackupSettingsPage {client} />
{/if}
