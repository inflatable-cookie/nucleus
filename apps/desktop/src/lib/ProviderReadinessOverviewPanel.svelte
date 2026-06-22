<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    queryProviderReadIntent,
    queryProviderReadinessOverview,
    type ControlProviderReadIntentEntryDto,
    type ControlProviderReadinessOverviewDto,
    type ProviderReadIntentQueryResult,
    type ProviderReadinessOverviewQueryResult,
  } from "./control";

  let loading = $state(false);
  let result = $state<ProviderReadinessOverviewQueryResult | null>(null);
  let readIntentResult = $state<ProviderReadIntentQueryResult | null>(null);
  let failure = $state<string | null>(null);

  const overview = $derived(result?.state === "record" ? result.overview : null);
  const readIntent =
    $derived(readIntentResult?.state === "record" ? readIntentResult.result : null);
  const sourceCounts = $derived(readIntent?.source_counts ?? null);
  const projection = $derived(readIntent?.projection ?? null);
  const statusLabel = $derived(
    loading
      ? "loading"
      : failure
        ? "error"
        : overview
          ? overview.status
          : (result?.state ?? "idle"),
  );
  const statusTone = $derived(
    loading
      ? "pending"
      : failure
        ? "danger"
        : overview?.status === "ready"
          ? "success"
          : overview?.status === "blocked" || overview?.status === "needs_repair"
            ? "warning"
            : "info",
  );
  const noEffectFlags = $derived(
    overview
      ? [
          ["credential_resolution", overview.credential_resolution_performed],
          ["provider_network", overview.provider_network_call_performed],
          ["provider_effect", overview.provider_effect_executed],
          ["callback_effect", overview.callback_effect_executed],
          ["interruption_effect", overview.interruption_effect_executed],
          ["recovery_effect", overview.recovery_effect_executed],
          ["task_mutation", overview.task_mutation_executed],
          ["raw_payload", overview.raw_provider_payload_retained],
        ]
      : [],
  );
  const sourceCountRows = $derived(
    sourceCounts
      ? [
          ["credential_status", sourceCounts.credential_status_records],
          ["repository_metadata", sourceCounts.repository_metadata_records],
          ["pull_request", sourceCounts.pull_request_records],
          ["status_check", sourceCounts.status_check_records],
        ]
      : [],
  );

  async function loadProviderReadinessOverview() {
    loading = true;
    failure = null;

    try {
      const [overviewResult, readIntentProjection] = await Promise.all([
        queryProviderReadinessOverview(),
        queryProviderReadIntent(),
      ]);
      result = overviewResult;
      readIntentResult = readIntentProjection;
    } catch (error) {
      result = null;
      readIntentResult = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function joined(values: string[]) {
    return values.length === 0 ? "none" : values.join(", ");
  }

  function refOrNone(value: string | null) {
    return value ?? "none";
  }

  function providerSummary(record: ControlProviderReadinessOverviewDto) {
    const providers = joined(record.forge_providers);
    const repos = joined(record.remote_repo_refs);
    return `${providers}; ${repos}`;
  }

  function entryProvider(entry: ControlProviderReadIntentEntryDto) {
    return joined(
      [entry.forge_provider, entry.provider_instance_ref, entry.remote_repo_ref].filter(
        (value): value is string => Boolean(value),
      ),
    );
  }

  $effect(() => {
    void loadProviderReadinessOverview();
  });
</script>

<Surface>
  <section class="provider-readiness-panel" aria-label="Provider Readiness Overview">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Provider readiness</h2>
        <Text tone="muted">Read-only forge overview.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if failure}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{failure}</Text>
      </div>
    {:else if loading}
      <div class="panel-message">
        <Text tone="muted">Loading provider readiness.</Text>
      </div>
    {:else if result?.state === "unsupported"}
      <div class="panel-message">
        <Text tone="muted">{result.reason}</Text>
      </div>
    {:else if result?.state === "error"}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{result.kind}: {result.reason}</Text>
      </div>
    {:else if result?.state === "unexpected"}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{result.reason}</Text>
      </div>
    {:else if !overview}
      <div class="panel-message">
        <Text tone="muted">No provider readiness overview available.</Text>
      </div>
    {:else}
      <div class="provider-readiness-layout">
        <dl class="provider-readiness-detail">
          <div>
            <dt>Overview</dt>
            <dd>{overview.overview_id}</dd>
          </div>
          <div>
            <dt>Projection</dt>
            <dd>{overview.projection_id}</dd>
          </div>
          <div>
            <dt>Project</dt>
            <dd>{refOrNone(overview.project_ref)}</dd>
          </div>
          <div>
            <dt>Repo</dt>
            <dd>{refOrNone(overview.repo_ref)}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{providerSummary(overview)}</dd>
          </div>
        </dl>

        <div class="provider-readiness-counts" aria-label="Provider readiness counts">
          <div>
            <span>{overview.total_read_intent_count}</span>
            <small>records</small>
          </div>
          <div>
            <span>{overview.ready_count}</span>
            <small>ready</small>
          </div>
          <div>
            <span>{overview.blocked_count}</span>
            <small>blocked</small>
          </div>
          <div>
            <span>{overview.repair_required_count}</span>
            <small>repair</small>
          </div>
          <div>
            <span>{overview.missing_evidence_family_count}</span>
            <small>missing</small>
          </div>
          <div>
            <span>{overview.evidence_ref_count}</span>
            <small>evidence</small>
          </div>
        </div>

        <div class="provider-readiness-section">
          <h3>Families</h3>
          <dl>
            <div>
              <dt>Supported</dt>
              <dd>{joined(overview.supported_read_families)}</dd>
            </div>
            <div>
              <dt>Represented</dt>
              <dd>{joined(overview.represented_read_families)}</dd>
            </div>
            <div>
              <dt>Mutating context</dt>
              <dd>{joined(overview.represented_mutating_families)}</dd>
            </div>
          </dl>
        </div>

        {#if readIntentResult?.state === "unsupported"}
          <div class="provider-readiness-section">
            <h3>Read-intent drilldown</h3>
            <Text tone="muted">{readIntentResult.reason}</Text>
          </div>
        {:else if readIntentResult?.state === "error"}
          <div class="provider-readiness-section">
            <h3>Read-intent drilldown</h3>
            <Text tone="danger">{readIntentResult.kind}: {readIntentResult.reason}</Text>
          </div>
        {:else if readIntentResult?.state === "unexpected"}
          <div class="provider-readiness-section">
            <h3>Read-intent drilldown</h3>
            <Text tone="danger">{readIntentResult.reason}</Text>
          </div>
        {:else if projection}
          <div class="provider-readiness-section">
            <h3>Source counts</h3>
            <ul>
              {#each sourceCountRows as [label, count]}
                <li>
                  <code>{label}</code>
                  <span>{count}</span>
                </li>
              {/each}
            </ul>
          </div>

          <div class="provider-readiness-section">
            <h3>Read-intent drilldown</h3>
            <ul>
              {#each projection.entries as entry}
                <li class="provider-readiness-entry">
                  <div>
                    <strong>{entry.family}</strong>
                    <small>{entry.operation_family}</small>
                    <code>{entryProvider(entry)}</code>
                  </div>
                  <span>{entry.status}</span>
                  <small>{entry.evidence_ref_count} evidence</small>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        <div class="provider-readiness-section">
          <h3>No-effect flags</h3>
          <ul>
            {#each noEffectFlags as [label, performed]}
              <li>
                <code>{label}</code>
                <span>{performed ? "performed" : "not_performed"}</span>
              </li>
            {/each}
          </ul>
        </div>
      </div>
    {/if}

    <div class="panel-actions">
      <Text tone="muted">No provider controls.</Text>
      <Button
        variant="secondary"
        leadingIcon={refreshCw}
        onClick={loadProviderReadinessOverview}
        disabled={loading}
      >
        Reload
      </Button>
    </div>
  </section>
</Surface>

<style>
  .provider-readiness-panel {
    display: grid;
    align-content: start;
    gap: var(--poodle-space-stack-md);
    min-width: 0;
  }

  .provider-readiness-layout {
    display: grid;
    gap: var(--poodle-space-stack-sm);
    min-width: 0;
  }

  .provider-readiness-detail,
  .provider-readiness-section dl {
    display: grid;
    gap: 1px;
    margin: 0;
    overflow: hidden;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-border-subtle);
  }

  .provider-readiness-detail div,
  .provider-readiness-section dl div {
    min-width: 0;
    padding: 0.65rem 0.75rem;
    background: var(--poodle-color-background-canvas);
  }

  .provider-readiness-detail dt,
  .provider-readiness-section dt {
    margin: 0 0 0.2rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.68rem;
    font-weight: 600;
  }

  .provider-readiness-detail dd,
  .provider-readiness-section dd {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--poodle-color-text-primary);
    font-family: var(--poodle-typography-code-family);
    font-size: 0.74rem;
    line-height: 1.35;
  }

  .provider-readiness-counts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
    min-width: 0;
  }

  .provider-readiness-counts div,
  .provider-readiness-section {
    display: grid;
    gap: 0.35rem;
    min-width: 0;
    padding: 0.75rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-background-canvas);
  }

  .provider-readiness-counts span {
    color: var(--poodle-color-text-primary);
    font-size: 1rem;
    font-weight: 650;
    line-height: 1.1;
  }

  .provider-readiness-counts small {
    overflow-wrap: anywhere;
    color: var(--poodle-color-text-secondary);
    font-size: 0.68rem;
  }

  .provider-readiness-section h3 {
    margin: 0;
    color: var(--poodle-color-text-primary);
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.3;
  }

  .provider-readiness-section ul {
    display: grid;
    gap: 0.45rem;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .provider-readiness-section li {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    min-width: 0;
    color: var(--poodle-color-text-primary);
    font-size: 0.75rem;
    line-height: 1.35;
  }

  .provider-readiness-entry {
    align-items: start;
  }

  .provider-readiness-entry div {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
  }

  .provider-readiness-section strong,
  .provider-readiness-section code {
    overflow-wrap: anywhere;
    font-family: var(--poodle-typography-code-family);
    font-size: 0.74rem;
  }

  .provider-readiness-section strong {
    color: var(--poodle-color-text-primary);
    font-weight: 650;
  }

  .provider-readiness-section small,
  .provider-readiness-section span {
    flex: 0 0 auto;
    color: var(--poodle-color-text-secondary);
    font-size: 0.72rem;
  }

  .provider-readiness-section small {
    overflow-wrap: anywhere;
  }
</style>
