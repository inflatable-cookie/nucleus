<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { Button, Callout, ConfirmAction, DetailItem, Surface } from "@poodle/svelte";
  import { onMount } from "svelte";

  type RestorePreparation = {
    requestId: string;
    archiveSha256: string;
    domains: string[];
    confirmationDigest: string;
    restartRequired: boolean;
  };

  type RestoreReceipt = {
    outcome: "noRequest" | "committed" | "rejectedOrRolledBack";
    recovery: "none" | "rolledBack" | "terminalCleanup";
    archiveSha256: string | null;
    entries: Array<{
      domain: string;
      targetEvidence: { state: "absent" } | { state: "present"; sha256: string };
      rollbackEvidence: { state: "absent" } | { state: "present"; sha256: string };
    }>;
    detail: string | null;
  };

  let preparation = $state<RestorePreparation | null>(null);
  let inspecting = $state(false);
  let restarting = $state(false);
  let error = $state<string | null>(null);
  let receipt = $state<RestoreReceipt | null>(null);

  onMount(() => {
    void loadReceipt();
  });

  async function loadReceipt(): Promise<void> {
    try {
      receipt = await invoke<RestoreReceipt | null>("nucleus_config_restore_status");
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function inspectArchive(): Promise<void> {
    inspecting = true;
    error = null;
    preparation = null;
    try {
      preparation = await invoke<RestorePreparation | null>("nucleus_config_restore_prepare");
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      inspecting = false;
    }
  }

  async function confirmRestore(): Promise<void> {
    if (preparation === null) return;
    restarting = true;
    error = null;
    try {
      await invoke("nucleus_config_restore_confirm", {
        confirmation: {
          requestId: preparation.requestId,
          archiveSha256: preparation.archiveSha256,
          confirmationDigest: preparation.confirmationDigest,
        },
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      restarting = false;
    }
  }

  function completedMessage(value: RestoreReceipt): string {
    const removed = value.entries.filter((entry) => entry.targetEvidence.state === "absent").length;
    const suffix = removed === 0 ? "" : `; ${removed} archived ${removed === 1 ? "absence was" : "absences were"} applied as deletion`;
    return `${value.entries.length} configuration domains were restored together${suffix}.`;
  }
</script>

<div class="nucleus-restore-page" aria-busy={inspecting || restarting}>
  {#if error}
    <Callout
      tone="danger"
      title="Restore unavailable"
      message={error}
      announceMode="assertive"
    />
  {/if}

  {#if receipt?.outcome === "committed"}
    <Callout
      tone="success"
      title="Last restore completed"
      message={completedMessage(receipt)}
    />
  {:else if receipt?.outcome === "rejectedOrRolledBack"}
    <Callout
      tone="warning"
      title={receipt.recovery === "rolledBack" ? "Last restore was rolled back" : "Last restore was rejected"}
      message={receipt.detail ?? "No configuration domains were changed."}
    />
  {/if}

  <Surface asRole="region" label="Choose restore archive">
    <h3>Restore from backup</h3>
    <p>
      Nucleus verifies the archive now, then restarts and restores all configuration domains
      together before the database or desktop services open.
    </p>
    <Button
      variant="secondary"
      loading={inspecting}
      disabled={inspecting || restarting}
      onClick={() => void inspectArchive()}
    >
      Choose backup archive…
    </Button>
  </Surface>

  {#if preparation}
    <Surface asRole="region" label="Verified restore plan">
      <h3>Verified restore plan</h3>
      <div class="nucleus-restore-details">
        <DetailItem label="Archive digest" value={preparation.archiveSha256} truncateValue={true} />
        <DetailItem label="Domains" value={`${preparation.domains.length}`} />
        <DetailItem label="Restart" value={preparation.restartRequired ? "Required" : "Not required"} />
      </div>
      <ul>
        {#each preparation.domains as domain (domain)}
          <li>{domain}</li>
        {/each}
      </ul>
      <p class="nucleus-restore-confirmation">{preparation.confirmationDigest}</p>
      <Callout
        tone="warning"
        title="Nucleus will restart"
        message="The exact archive and seven-domain plan will be rechecked at boot. A mismatch changes nothing. An interrupted publication is rolled back before the app opens."
      />
      <ConfirmAction
        title="Restart and restore this exact backup?"
        description="Current Nucleus configuration will be replaced as one recoverable group. Project repositories and provider credentials are excluded."
        triggerLabel="Restore this backup…"
        confirmLabel="Restart and restore"
        onConfirm={confirmRestore}
      />
    </Surface>
  {/if}

  {#if restarting}
    <Callout
      tone="warning"
      title="Restore scheduled"
      message="Nucleus is restarting. Keep the application closed until boot recovery completes."
      announceMode="assertive"
    />
  {/if}
</div>

<style>
  .nucleus-restore-page,
  .nucleus-restore-details {
    display: grid;
    gap: 0.75rem;
  }

  .nucleus-restore-details {
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  }

  .nucleus-restore-confirmation {
    color: var(--poodle-color-text-muted);
    overflow-wrap: anywhere;
  }
</style>
