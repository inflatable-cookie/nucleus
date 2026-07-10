<script lang="ts">
  import { Icon } from "@poodle/svelte";
  import { check } from "@poodle/icons-lucide";
  import type { TaskWorkflowReceipt } from "./control/agentChat";

  let {
    receipt,
    onOpen,
  }: {
    receipt: TaskWorkflowReceipt;
    onOpen: () => void;
  } = $props();

  const label = $derived(
    receipt.status === "review_ready"
      ? "Ready for review"
      : receipt.status === "recovery_required"
        ? "Recovery required"
        : receipt.status === "blocked"
          ? "Blocked"
          : "Stopped",
  );
</script>

<div class:attention={receipt.status !== "review_ready"} class="workflow-receipt">
  <button type="button" class="receipt-main" onclick={onOpen}>
    <Icon icon={check} size="sm" />
    <span>
      <strong>{label}</strong>
      · {receipt.scope_kind === "goal" ? "Goal" : "Task"}
      · {receipt.current_position}/{receipt.total_tasks}
    </span>
  </button>
  <span class="receipt-summary">{receipt.summary}</span>
  <details>
    <summary>Details</summary>
    <dl>
      <div><dt>Mandate</dt><dd>{receipt.mandate_id}</dd></div>
      {#if receipt.plan_id}<div><dt>Plan</dt><dd>{receipt.plan_id}</dd></div>{/if}
      <div><dt>Work items</dt><dd>{receipt.work_item_refs.length}</dd></div>
      <div><dt>Receipts</dt><dd>{receipt.runtime_receipt_refs.length}</dd></div>
    </dl>
  </details>
</div>

<style>
  .workflow-receipt {
    display: grid;
    gap: 0.35rem;
    width: min(34rem, 100%);
    margin-top: 0.35rem;
    padding: 0.5rem 0.6rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.78rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
  }

  .workflow-receipt.attention { border-color: var(--poodle-color-border-default); }
  .receipt-main { display: flex; align-items: center; gap: 0.4rem; padding: 0; color: inherit; font: inherit; text-align: left; border: 0; background: transparent; cursor: pointer; }
  .receipt-main:hover { color: var(--poodle-color-text-primary); }
  .receipt-summary { line-height: 1.4; }
  details { border-top: 1px solid var(--poodle-color-border-subtle); padding-top: 0.35rem; }
  summary { width: fit-content; cursor: pointer; }
  dl { display: grid; gap: 0.25rem; margin: 0.45rem 0 0; }
  dl div { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); gap: 0.5rem; }
  dt { color: var(--poodle-color-text-tertiary); }
  dd { margin: 0; overflow-wrap: anywhere; }
</style>
