# 059 — Subscription usage pressure gauge

Status: implemented (steps 1 and 2, including the Usage page and the Paseo sidebar rail)
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
  end count as the window), and uniform pace `p = u/e`; recent samples do not affect the pace,
  dial, state, or exhaustion time. The dial is `clamp(log2 p, -1, 1)`, damped toward centre while
  `e < 0.05`, pinned right at `u >= 1`; `exhaustsInMs` uses the same uniform rate and counts when
  exhaustion lands before that window's own reset, except a fully used window — exhausted now,
  whatever its reset says — which reports `exhaustsInMs` 0. The binding window is whichever hits 100%
  earliest before its own reset; a fully used window binds regardless of its reset, and with
  none running out the closest call (highest dial) names the dial. The state is `will_run_out`
  when the binding window exhausts before its reset or is already fully used, `on_track` when
  its dial sits within ±0.05 of centre, `spare` left of that, and `unknown` when no window
  carries enough data to project. Partial windows whose reset has passed project nothing
  (stale, not zero); a fully used one still pins. The projected use at reset keeps its
  over-projection past 100% (schema-capped at twice the window, where the dial is pinned anyway)
  so the dial's label can say "+18% over"; a fully used window reads exactly 100%.

- **The Usage page** (step 2) lives on the board's navigation in the shared client, so the web
  board and the plugin render the same screen; nothing lands in the board header (Tom,
  2026-11-06). One card per subscription: a semicircle dial with a needle (centre on track, right
  red runs out, left green spare), the projected use at reset and the binding window as its
  caption ("+18% over · wk", "-30% spare · 5h"), each window's used percent, reset time relative
  and absolute, time to exhaustion when exhaustion comes first, the sample age and source, and
  any stored read error. Unknown and not-available readings read plainly with their reason, never
  as 0 or green. The page refreshes on a slow minute interval — the readers pace themselves, so
  the page adds no fast polling.

- **The Paseo sidebar rail** is a compact plugin-only contribution: one small ring per
  subscription, the provider icon inside, the ring's colour and fill showing the pressure state,
  each ring opening the Usage screen. The screen and the custom sidebar item use the host's newer
  registration APIs read through optional members (the pinned plugin SDK's types do not carry
  them), so older hosts keep the board-navigation page and simply render no rail.

- **`usage.state`** (read-only) serves every subscription with its latest reading, the
  projection, and freshness (`asOf`, `nextReadAt`, `lastAttemptAt`, `lastError`). The CLI reads
  it with `nucleus usage.state`. The Usage page and the Paseo sidebar rail read the same RPC.

- **Schema.** The store gains `usage_samples` and `usage_read_state` (per-subscription schedule,
  backoff and latest reading); store schema 58. Old stores migrate by re-running the fresh-store
  schema, as with any added table.

## Acceptance oracle

`test/usage-readers.test.ts` (each reader against recorded shapes, including unknown and renamed
fields, and a real subprocess fixture for the Codex app-server and Grok CLI paths);
`test/usage-projection.test.ts` (on track, spare, run-out, early damping, usage ahead of elapsed
time without recent-sample influence, multiple
windows, pinned at 100%, stale and insufficient data);
`test/usage-service.test.ts` (subscription mapping, account separation, pacing, backoff to the
cap, retention, thrown-reader recovery); `test/catalogue.test.ts` (the read-only
classification); `test/usage-gauge-ui.test.ts` (the dial maps state and value — centre, left,
right, pinned, unknown — the page renders subscriptions from a `usage.state` fixture, the rail
renders and links to the page, and the plugin shell renders the page from the board navigation);
`test/web-shell.test.ts` (the web bundle renders the board that carries the page). The local
check runs `usage.state` against a copy of the live store with the real provider homes and shows
the operator's subscriptions with sane values; the store copy — never the live database —
migrates and receives the samples. The installed UI is checked in dark theme after the roll by
the planner; a worker never tests on the operator's display.

## Later

- Usage-aware routing (lean away from a subscription projected to run out) stays out until the
  gauge is stable (Tom, 2026-11-11).
