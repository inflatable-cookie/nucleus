<script lang="ts">
  import { SettingsShell } from "@inflatable-cookie/longhorn-poodle-svelte/settings/poodle";
  import type {
    SettingsPageRenderContext,
    SettingsPageRenderer,
    SettingsSession,
  } from "@inflatable-cookie/longhorn-poodle-svelte/settings/svelte";
  import type { CommandSession } from "@inflatable-cookie/longhorn-poodle-svelte/commands/svelte";
  import { createNucleusSettingsSession } from "./client";
  import LazySettingsPage from "./pages/LazySettingsPage.svelte";

  interface Props {
    onOpenChange: (open: boolean) => void;
    session?: SettingsSession;
    commandSession?: CommandSession;
  }

  let { onOpenChange, session: suppliedSession, commandSession }: Props = $props();
  let open = $state(true);
  const ownedSession = createNucleusSettingsSession(
    () => onOpenChange(false),
    (error) => console.warn("settings session failed", error),
  );
  const session = $derived(suppliedSession ?? ownedSession);

  function resolveRenderer(): SettingsPageRenderer {
    return settingsPage;
  }
</script>

{#snippet settingsPage(context: SettingsPageRenderContext)}
  {#key context.page.id}
    <LazySettingsPage {context} {commandSession} />
  {/key}
{/snippet}

<SettingsShell
  {session}
  bind:open
  title="Settings"
  ariaLabel="Nucleus settings"
  resolveRenderer={resolveRenderer}
  onOpenChange={(next) => {
    open = next;
    if (!next) onOpenChange(false);
  }}
/>
