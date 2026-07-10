<script lang="ts">
  import { Icon } from "@poodle/svelte";
  import { check } from "@poodle/icons-lucide";
  import type { TaskAuthoringReceipt } from "./control/agentChat";

  let {
    receipt,
    onOpen,
  }: {
    receipt: TaskAuthoringReceipt;
    onOpen: () => void;
  } = $props();

  const readyCount = $derived(
    [...receipt.created, ...receipt.updated].filter((task) => task.activity === "ready").length,
  );
  const affectedCount = $derived(receipt.created.length + receipt.updated.length);
  const affectedGoalCount = $derived(receipt.goals_created.length + receipt.goals_updated.length);
</script>

<button type="button" class="task-receipt" onclick={onOpen}>
  <Icon icon={check} size="sm" />
  {#if receipt.goals_created.length === 1 && affectedCount === 0 && receipt.goals_updated.length === 0}
    <span>Goal created · {receipt.goals_created[0].title}</span>
  {:else if receipt.goals_updated.length === 1 && affectedCount === 0 && receipt.goals_created.length === 0}
    <span>Goal updated · {receipt.goals_updated[0].title}</span>
  {:else if receipt.created.length === 1 && receipt.updated.length === 0}
    <span>Task created · {receipt.created[0].title}</span>
  {:else if receipt.updated.length === 1 && receipt.created.length === 0}
    <span>Task updated · {receipt.updated[0].title}</span>
  {:else if receipt.updated.length === 0}
    <span>
      {receipt.created.length} tasks created · {readyCount} ready · {receipt.created.length - readyCount} proposed
    </span>
  {:else if receipt.created.length === 0}
    <span>{receipt.updated.length} tasks updated</span>
  {:else if affectedCount > 0 && affectedGoalCount > 0}
    <span>{affectedCount} tasks · {affectedGoalCount} goals changed</span>
  {:else if affectedCount > 0}
    <span>{affectedCount} tasks changed</span>
  {:else}
    <span>{affectedGoalCount} goals changed</span>
  {/if}
</button>

<style>
  .task-receipt {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: fit-content;
    margin-top: 0.35rem;
    padding: 0.45rem 0.6rem;
    color: var(--poodle-color-text-secondary);
    font: inherit;
    font-size: 0.78rem;
    text-align: left;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
    cursor: pointer;
  }

  .task-receipt:hover {
    color: var(--poodle-color-text-primary);
    border-color: var(--poodle-color-border-default);
  }
</style>
