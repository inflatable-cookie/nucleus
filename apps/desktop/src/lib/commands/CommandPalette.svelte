<script lang="ts">
  import { CommandPalette, type CommandActionItem, type DiscoveryState } from "@poodle/svelte";
  import type { CommandSession } from "@inflatable-cookie/longhorn-commands/svelte";

  let { session }: { session: CommandSession } = $props();

  const items = $derived<CommandActionItem[]>(session.paletteRecords.map((record) => ({
    id: record.id,
    title: record.label,
    description: record.availability.state === "available"
      ? record.description
      : record.availability.reason?.detail ?? record.description,
    group: record.categoryPath.join(" / "),
    shortcut: record.shortcuts[0]?.label ?? null,
    keywords: [...record.keywords],
    disabled: record.availability.state !== "available",
  })));
  const state = $derived<DiscoveryState>(
    session.status.kind === "idle" || session.status.kind === "loading"
      ? "loading"
      : session.status.kind !== "ready"
        ? "error"
        : items.length === 0
          ? session.query.length === 0 ? "empty" : "no-results"
          : "ready",
  );
</script>

<CommandPalette
  open={session.open}
  query={session.query}
  {items}
  {state}
  title="Command Palette"
  invocationHint="⌘⇧P"
  onOpenChange={(open) => session.setOpen(open)}
  onQueryChange={(query) => void session.setQuery(query)}
  onCommandSelect={(commandId) => void session.select(commandId)}
/>
