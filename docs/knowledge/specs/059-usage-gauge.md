# 059 — Subscription usage pressure gauge

Status: step 1 (data) implemented; the Usage page and sidebar rail (step 2, U2) pending
Owner: Nucleus runtime maintainers
Created: 2026-11-11
Decision owner: operator (Tom, 2026-11-11, lane document `nucleus-usage-gauge`: track each
provider subscription's usage against its reset date and say whether it will run out before the
reset; a dial — centre on track, right red runs out, left green spare; Codex, Claude and Grok in
v1; usage-aware routing later)

## Problem

Nucleus dispatches every run through one of the operator's provider subscriptions, but nothing
says when a subscription is about to run out before its reset. The operator learns about
exhaustion from a refused run, after the fact.

## Rule

- **Per subscription, not per provider.** A subscription is one of Nucleus's existing profile
  pool groups. Each stored profile names a provider; the group's provider key maps leniently
  (`codex`, `claude`, `grok` substrings, case-insensitive) to a v1 reader. A group naming two
  readable providers tracks each as its own subscription; a provider with no reader gains no
  subscription. Two accounts never merge: readings carry the provider's own `accountId` /
  `accountUuid`, and samples key on it.

- **Readers in core, no credentials, no turns** (`core/usage/`). None polls a provider endpoint
  and none reads a credential file:
  - **Codex** reads `codex app-server` JSON-RPC over stdio (`initialize`, then
    `account/rateLimits/read` with `excludeResetCreditDetails: true`) with the subscription's
    `CODEX_HOME` (env or `~/.codex`). Any failure falls back to the latest `token_count`
    `rate_limits` event in that home's `sessions/**/rollout-*.jsonl`, marked as of the event.
  - **Claude** reads `cachedUsageUtilization` from the config dir's `.claude.json`
    (`CLAUDE_CONFIG_DIR` or the home), read only and never written, with `fetchedAtMs` as the
    sample time.
  - **Grok** runs `grok usage --json` (the CLI holds the login): one credit gauge, `creditUsagePercent`,
    with the billing period when the CLI reports it.
  Schemas are lenient: an unreadable or unexpected shape is an `unknown` reading with the reason,
  never 0; a subscription with no usable source reads `not_available`.

- **Paced reads with backoff.** The service reads Codex and Grok every five minutes and Claude
  every two (Claude follows its cache; an unchanged cache stores no duplicate sample). A failed
  read backs off by doubling from one minute to the hour cap, and success resets. The service
  owns the cadence, so `usage.state` itself is read-only. A subscription's first sample waits for
  the service's first tick, and the reading shows `unknown` ("not sampled yet") until then.

- **Stored samples, bounded retention.** One row per window per read in `usage_samples`
  (group, provider, account, window id, used fraction, window length, window start, reset,
  sampled at, source), pruned to 14 days on a daily pass.

- **The pressure projection is pure** (`shared/usage-projection.ts`). Per window: used fraction
  `u`, elapsed fraction `e` from the window length and reset (a billing period's own start and
  end count as the window), uniform pace `p = u/e` blended half-and-half with the recent burn
  from samples within the last hour; dial `clamp(log2 p, -1, 1)`, damped toward centre while
  `e < 0.05`, pinned right at `u >= 1`; `exhaustsInMs` counts when exhaustion lands before that
  window's own reset (pace above 1), except a fully used window — exhausted now, whatever its
  reset says — which reports `exhaustsInMs` 0. The binding window is whichever hits 100%
  earliest before its own reset; a fully used window binds regardless of its reset, and with
  none running out the closest call (highest dial) names the dial. The state is `will_run_out`
  when the binding window exhausts before its reset or is already fully used, `on_track` when
  its dial sits within ±0.05 of centre, `spare` left of that, and `unknown` when no window
  carries enough data to project. Partial windows whose reset has passed project nothing
  (stale, not zero); a fully used one still pins.

- **`usage.state`** (read-only) serves every subscription with its latest reading, the
  projection, and freshness (`asOf`, `nextReadAt`, `lastAttemptAt`, `lastError`). The CLI reads
  it with `nucleus usage.state`. The Usage page (step 2) and the Paseo sidebar rail read the same
  RPC; nothing lands in the board header (Tom, 2026-11-06).

- **Schema.** The store gains `usage_samples` and `usage_read_state` (per-subscription schedule,
  backoff and latest reading); store schema 58. Old stores migrate by re-running the fresh-store
  schema, as with any added table.

## Acceptance oracle

`test/usage-readers.test.ts` (each reader against recorded shapes, including unknown and renamed
fields, and a real subprocess fixture for the Codex app-server and Grok CLI paths);
`test/usage-projection.test.ts` (on track, spare, run-out, early damping, recent burn, multiple
windows, pinned at 100%, stale and insufficient data);
`test/usage-service.test.ts` (subscription mapping, account separation, pacing, backoff to the
cap, retention, thrown-reader recovery); `test/catalogue.test.ts` (the read-only
classification). The local check runs `usage.state` against a copy of the live store with the
real provider homes and shows the operator's subscriptions with sane values; the store copy —
never the live database — migrates and receives the samples.

## Later

- Step 2 (U2): the Usage page in the web board and the Paseo plugin, one pressure dial per
  subscription with window details, plus a compact ring rail in Paseo's sidebar.
- Usage-aware routing (lean away from a subscription projected to run out) stays out until the
  gauge is stable (Tom, 2026-11-11).
