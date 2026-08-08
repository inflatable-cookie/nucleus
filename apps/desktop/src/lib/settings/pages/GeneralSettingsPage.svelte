<script lang="ts">
  import { Button, Switch, Text } from "@inflatable-cookie/poodle-svelte";
  import type { SettingsPageRenderContext } from "@inflatable-cookie/longhorn-settings/svelte";
  import {
    FIXTURE_STATUS_ENTRY_ID,
    GENERAL_SCOPE_ID,
    GENERAL_UNIT_ID,
  } from "../client";

  let { context }: { context: SettingsPageRenderContext } = $props();
  const snapshot = $derived(context.snapshot(GENERAL_SCOPE_ID));
  const showFixtureStatus = $derived(
    snapshot?.values.find(({ entryId }) => entryId === FIXTURE_STATUS_ENTRY_ID)
      ?.effective.value !== false,
  );
</script>

<div class="settings-page" data-testid="settings-general-page">
  <section class="settings-row">
    <div>
      <Text weight="medium">Fixture status</Text>
      <Text tone="muted" size="sm">
        Show the small fixture-backed indicator when local seed data is active.
      </Text>
    </div>
    <Switch
      checked={showFixtureStatus}
      ariaLabel="Show fixture status"
      disabled={context.busy}
      onCheckedChange={(checked) => {
        void context.change(GENERAL_UNIT_ID, {
          codecVersion: 1,
          value: { showFixtureStatus: checked },
        });
      }}
    />
  </section>
  <Button
    variant="ghost"
    disabled={context.busy}
    onClick={() => void context.requestReset(GENERAL_UNIT_ID, [FIXTURE_STATUS_ENTRY_ID])}
  >
    Reset General
  </Button>
</div>

<style>
  .settings-page {
    display: grid;
    gap: 1rem;
  }

  .settings-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 1rem;
  }
</style>
