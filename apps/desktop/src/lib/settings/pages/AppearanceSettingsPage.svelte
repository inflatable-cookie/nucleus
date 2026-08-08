<script lang="ts">
  import { Button, RadioGroup, Text } from "@poodle/svelte";
  import type { SettingsPageRenderContext } from "@inflatable-cookie/longhorn-settings/svelte";
  import {
    APPEARANCE_SCOPE_ID,
    APPEARANCE_UNIT_ID,
    DENSITY_ENTRY_ID,
  } from "../client";

  let { context }: { context: SettingsPageRenderContext } = $props();
  const snapshot = $derived(context.snapshot(APPEARANCE_SCOPE_ID));
  const effectiveDensity = $derived(
    snapshot?.values.find(({ entryId }) => entryId === DENSITY_ENTRY_ID)
      ?.effective.value === "comfortable"
      ? "comfortable"
      : "compact",
  );
  const draftDensity = $derived.by(() => {
    const value = context.draft(APPEARANCE_UNIT_ID)?.intent.value;
    if (!value || typeof value !== "object" || !("density" in value)) return null;
    return value.density === "comfortable" ? "comfortable" : "compact";
  });
  const density = $derived(draftDensity ?? effectiveDensity);
</script>

<div class="settings-page" data-testid="settings-appearance-page">
  <section class="settings-field">
    <div>
      <Text weight="medium">Interface density</Text>
      <Text tone="muted" size="sm">
        Choose how much space controls use throughout the desktop shell.
      </Text>
    </div>
    <RadioGroup
      value={density}
      options={[
        { value: "compact", label: "Compact" },
        { value: "comfortable", label: "Comfortable" },
      ]}
      orientation="horizontal"
      ariaLabel="Interface density"
      disabled={context.busy}
      onValueChange={(value) => {
        void context.change(APPEARANCE_UNIT_ID, {
          codecVersion: 1,
          value: { density: value },
        });
      }}
    />
  </section>
  <Button
    variant="ghost"
    disabled={context.busy}
    onClick={() => void context.requestReset(APPEARANCE_UNIT_ID, [DENSITY_ENTRY_ID])}
  >
    Reset Appearance
  </Button>
</div>

<style>
  .settings-page,
  .settings-field {
    display: grid;
    gap: 1rem;
  }
</style>
