# 059 — Subscription usage pressure gauge

Status: implemented (steps 1 and 2, including the Usage page and the Paseo sidebar row)
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
  - **Grok** calls `_x.ai/billing` through `grok agent stdio` (the CLI holds the login): one credit
    gauge, `creditUsagePercent`, with the current billing period. Initialization times out after
    15 seconds and billing after 10 seconds to allow a cold CLI start; a local fresh-process
    read measured 263 ms for initialization and 561 ms for billing. Unsupported billing and
    malformed results stay `unknown`. `grok usage --json`
    is only a fallback when agent stdio cannot start or initialize. The configured `GROK_HOME` is
    passed to the CLI for the subscription.
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
  2026-11-06). One card per subscription (nucleus#1124, #1127): a large semicircle dial on the left,
  vertically centred (centre on track, right red runs out, left green spare), and one column to
  its right with the provider mark and name, a plain verdict sentence and a row per window (name,
  reset day and time rounded to the nearest minute, a bar in the state colour with a neutral
  on-pace marker at elapsed time, percent used). Below a card width of 460 px the dial stacks
  above the column. The verdict says "Plenty of room" only when projected use at reset is 80% or
  less; above that, short of running out, it says "On track" with the spare share. Sample age,
  source and next read sit in the card's (?) popover. Unknown and not-available readings read plainly with their reason, never
  as 0 or green. The page refreshes on a slow minute interval — the readers pace themselves, so
  the page adds no fast polling. Provider headings omit a group that only repeats the provider;
  the shared ProviderLogo uses bundled official marks for Codex, Claude and Grok, with the
  existing generic icon retained for unknown providers. See [third-party notices](../../../THIRD_PARTY_NOTICES.md)
  for mark sources and terms.

- **The Paseo sidebar row** is a compact plugin-only contribution (nucleus#1123): one row
  holds the board button on the left (icon and title, opening the board, the host's active
  highlight while the board is the open screen, hover and keyboard focus as the host's native
  items) and one small ring per subscription right-aligned on the same row — the provider mark
  inside, the ring's colour and fill showing the pressure state. Each ring opens the board on
  its Usage tab, not a separate screen, and there is no standalone Usage screen registration.
  The board registers as a host screen and the row as a host sidebar item through the newer
  registration APIs read as optional members (the pinned plugin SDK's types do not carry
  them); on those hosts neither Paseo's native sidebar item nor the plugin's own
  untitled legacy surface is registered, so nothing appears twice. Older hosts keep the
  surface and the native item, and render no row. Provider marks are white PNGs
  rasterised from the vendor SVGs, cropped to the mark, and tinted with the Image `tintColor`
  to the theme text colour (nucleus#1127): SVG data URIs did not paint in the real shells. The
  rings are 26 px with a 14 px mark.

- **`usage.state`** (read-only) serves every subscription with its latest reading, the
  projection, and freshness (`asOf`, `nextReadAt`, `lastAttemptAt`, `lastError`). After a failed
  refresh it keeps the last successful reading and projection while its windows remain current,
  and adds `stale` with the failure reason, time and reading age. Once all known windows have
  reset, it keeps the value as of its sample time, marks it expired, and returns an unknown dial.
  With no successful reading, it returns the failure as unknown. The CLI reads it with
  `nucleus usage.state`. The Usage page and the Paseo sidebar row read the same RPC.

- **Schema.** The store gains `usage_samples` and `usage_read_state` (per-subscription schedule,
  backoff and latest reading); store schema 58. Old stores migrate by re-running the fresh-store
  schema, as with any added table.

## Acceptance oracle

`test/usage-readers.test.ts` (each reader against recorded shapes, including unknown and renamed
fields, and subprocess fixtures for the Codex app-server and Grok agent stdio paths, including
current credits, legacy billing, unsupported method and timeout);
`test/usage-projection.test.ts` (on track, spare, run-out, early damping, recent burn, usage ahead
of elapsed time without recent-sample influence, multiple windows, pinned at 100%, stale and
insufficient data);
`test/usage-service.test.ts` (subscription mapping, account separation, pacing, backoff to the
cap, retention, thrown-reader recovery); `test/catalogue.test.ts` (the read-only
classification); `test/usage-gauge-ui.test.ts` (the dial maps state and value — centre, left,
right, pinned, unknown — the page renders subscriptions from a `usage.state` fixture, the
sidebar row renders the board button and the rings, opens the board's Usage tab and takes the
host's active state, a host without the newer APIs registers the native sidebar item, each
provider mark decodes to a PNG that paints visible pixels filling its box, cards put the dial left of the column and stack when narrow, the bar takes the state colour, the 80% verdict threshold and minute-rounded resets, and the plugin shell renders the page from the
board navigation);
`test/web-shell.test.ts` (the web bundle renders the board that carries the page). The local
check runs `usage.state` against a copy of the live store with the real provider homes and shows
the operator's subscriptions with sane values; the store copy — never the live database —
migrates and receives the samples. The installed UI is checked in dark theme after the roll by
the planner; a worker never tests on the operator's display.

## Later

- Usage-aware routing (lean away from a subscription projected to run out) stays out until the
  gauge is stable (Tom, 2026-11-11).
