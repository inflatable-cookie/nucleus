<script lang="ts">
  import { KeybindingSettings } from "@inflatable-cookie/longhorn-poodle-svelte/commands/poodle";
  import type {
    CommandEffectiveBinding,
    CommandKeyChord,
    CommandKeymapOverride,
    CommandKeymapPatch,
  } from "@inflatable-cookie/longhorn/commands";
  import type { CommandSession } from "@inflatable-cookie/longhorn-poodle-svelte/commands/svelte";

  let { commandSession }: { commandSession: CommandSession } = $props();
  let query = $state("");
  let processedCapture = $state<string | null>(null);
  const busy = $derived(
    commandSession.mutation.kind === "previewing"
      || commandSession.mutation.kind === "committing",
  );

  $effect(() => {
    const captured = commandSession.captured;
    if (!captured) return;
    const token = `${captured.bindingId}:${captured.label}`;
    if (processedCapture === token) return;
    const binding = commandSession.settingsRecords
      .flatMap((record) => record.bindings)
      .find(({ id }) => id === captured.bindingId);
    if (!binding) return;
    processedCapture = token;
    commandSession.stagePatch(patchFor(binding, captured.chord));
  });

  function patchFor(binding: CommandEffectiveBinding, chord: CommandKeyChord): CommandKeymapPatch {
    const trigger = { code: chord.code, modifiers: { primary: false, ...chord.modifiers } };
    const removeBindingIds: string[] = [];
    let directive: CommandKeymapOverride;
    if (binding.source.kind === "addedOverride") {
      removeBindingIds.push(binding.id);
      directive = {
        kind: "add",
        binding: {
          id: binding.id,
          platform: binding.platform,
          trigger,
          contextId: binding.contextId,
          commandId: binding.invocation.commandId,
          arguments: null,
        },
      };
    } else {
      directive = {
        kind: "replace",
        bindingId: binding.id,
        replacement: {
          platform: binding.platform,
          trigger,
          contextId: binding.contextId,
          commandId: binding.invocation.commandId,
          arguments: null,
        },
      };
    }
    return { activePresetId: null, clearOverrides: false, removeBindingIds, upsertOverrides: [directive] };
  }
</script>

<KeybindingSettings
  records={commandSession.settingsRecords}
  conflicts={commandSession.projection?.conflicts ?? []}
  {query}
  captureBindingId={commandSession.captureBindingId}
  capturedLabel={commandSession.captured?.label ?? null}
  dirty={commandSession.dirty}
  {busy}
  onQueryChange={(value) => (query = value)}
  onCapture={(bindingId) => commandSession.beginCapture(bindingId)}
  onCancelCapture={() => commandSession.cancelCapture()}
  onApply={() => void commandSession.applyDraft()}
  onCancel={() => commandSession.cancelDraft()}
  onReset={() => void commandSession.resetKeymap()}
/>
