<script lang="ts">
  import { Button, TextInput } from "@poodle/svelte";

  let {
    message,
    busy,
    disabled = false,
    result = null,
    onMessageChange,
    onCommit,
  }: {
    message: string;
    busy: boolean;
    disabled?: boolean;
    result?: string | null;
    onMessageChange: (message: string) => void;
    onCommit: () => void;
  } = $props();

  function handleKeydown(event: KeyboardEvent): void {
    if (
      (event.metaKey || event.ctrlKey)
      && event.key === "Enter"
      && message.trim()
      && !busy
      && !disabled
    ) {
      event.preventDefault();
      onCommit();
    }
  }
</script>

<div class="commit-composer">
  <TextInput
    value={message}
    type="multiline"
    rows={2}
    resize="none"
    maxLength={16384}
    placeholder="Commit message"
    ariaLabel="Commit message"
    size="sm"
    density="compact"
    disabled={busy}
    showClearButton={false}
    onValueChange={onMessageChange}
    onKeyDown={handleKeydown}
  />
  <div class="commit-actions">
    {#if result}<span class="commit-result">{result}</span>{/if}
    <span class="spacer"></span>
    <Button
      variant="primary"
      size="sm"
      disabled={disabled || busy || !message.trim()}
      onClick={onCommit}
    >
      {busy ? "Committing…" : "Commit"}
    </Button>
  </div>
</div>

<style>
  .commit-composer {
    display: grid;
    gap: 0.4rem;
    margin-top: 0.25rem;
    padding: 0.5rem 0.375rem 0.25rem;
    border-top: 1px solid var(--poodle-color-border-subtle);
  }

  .commit-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .commit-result {
    overflow: hidden;
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }
</style>
