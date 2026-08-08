<script lang="ts">
  import type { Component } from "svelte";
  import type { SettingsPageRenderContext } from "@inflatable-cookie/longhorn-settings/svelte";
  import type { CommandSession } from "@inflatable-cookie/longhorn-commands/svelte";
  import {
    APPEARANCE_RENDERER_ID,
    AGENT_RENDERER_ID,
    GENERAL_RENDERER_ID,
  } from "../client";

  let {
    context,
    commandSession,
  }: {
    context: SettingsPageRenderContext;
    commandSession?: CommandSession;
  } = $props();
  let Page = $state<Component<any> | null>(null);
  let loadFailure = $state<string | null>(null);

  $effect(() => {
    const rendererId = context.page.rendererId;
    let current = true;
    Page = null;
    loadFailure = null;
    const load = rendererId === GENERAL_RENDERER_ID
      ? import("./GeneralSettingsPage.svelte")
      : rendererId === APPEARANCE_RENDERER_ID
        ? import("./AppearanceSettingsPage.svelte")
        : rendererId === AGENT_RENDERER_ID
          ? import("./AgentProviderSettingsPage.svelte")
          : rendererId === "longhorn:commands.keybindings"
            ? import("./KeybindingsSettingsPage.svelte")
            : rendererId === "longhorn:config.storage" ||
                rendererId === "longhorn:config.backup" ||
                rendererId === "longhorn:config.restore"
              ? import("./ConfigOperationsSettingsPage.svelte")
            : Promise.reject(new Error(`Unknown settings renderer ${rendererId}`));
    void load
      .then((module) => {
        if (current) Page = module.default;
      })
      .catch((error) => {
        if (current) loadFailure = String(error);
      });
    return () => {
      current = false;
    };
  });
</script>

{#if Page}
  {#if context.page.rendererId === "longhorn:commands.keybindings"}
    {#if commandSession}
      <Page {commandSession} />
    {:else}
      <p role="alert">Keybindings are unavailable.</p>
    {/if}
  {:else if context.page.rendererId === "longhorn:config.storage" ||
    context.page.rendererId === "longhorn:config.backup" ||
    context.page.rendererId === "longhorn:config.restore"}
    <Page rendererId={context.page.rendererId} />
  {:else}
    <Page {context} />
  {/if}
{:else if loadFailure}
  <p role="alert">{loadFailure}</p>
{:else}
  <p aria-live="polite">Loading page.</p>
{/if}
