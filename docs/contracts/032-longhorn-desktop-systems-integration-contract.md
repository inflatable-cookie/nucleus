# 032 Longhorn Desktop Systems Integration Contract

Status: active
Owner: Tom
Updated: 2026-08-02

## Purpose

Define how Nucleus may consume additional Longhorn desktop mechanisms after
the accepted storage, window, layout, renderer, and native Browser migration.

Longhorn supplies reusable mechanism authority. Nucleus retains product
meaning, authorization, persistence, policy, copy, and consequences.

Governing shared contracts:

- `../../../longhorn/docs/contracts/005-settings-and-system-registration.md`
- `../../../longhorn/docs/contracts/006-command-action-and-input.md`
- `../../../longhorn/docs/contracts/007-optional-backend-topology.md`
- `../../../longhorn/docs/contracts/008-history-kernel-boundary.md`
- `../../../longhorn/docs/contracts/011-cross-window-transfer.md`
- `../../../longhorn/docs/contracts/015-async-operation-lifecycle.md`
- `../../../longhorn/docs/contracts/016-notification-ledger-and-projection.md`
- `../../../longhorn/docs/contracts/017-native-content-island-coordination.md`

## General Adoption Rule

Each Longhorn adoption must:

- select one exact Longhorn source or produced artifact identity
- prove one dependency graph without duplicate Svelte or Poodle runtimes
- map Nucleus product authority through typed adapters
- remove any superseded active Nucleus mechanism in the same batch
- retain explicit failure, stale-state, teardown, and restart behavior
- keep raw secrets, provider payloads, terminal bytes, Browser data, and
  product records outside generic Longhorn documents
- stop when a required Nucleus product policy or remote transport contract is
  missing

Private sibling path dependencies are allowed before publication. They are not
reproducible artifact evidence. Every acceptance closeout must record the exact
clean Longhorn source and matching produced package graph.

New integration code must enter focused modules. It must not increase the
existing `storage_migration`, `browser_panel`, `workspace_ui/runtime`, or
`desktop_profile` structural findings. Existing retained adapters should be
split before adjacent Longhorn systems are added to them.

## Settings

Longhorn may own:

- the sealed settings registry and deterministic navigation
- page/session lifecycle, staged drafts, conflicts, reset, and activation
- modal, window, or panel shell composition through public Poodle bindings
- config-domain apply units and shared storage/recovery page mechanisms

Nucleus owns:

- settings modules, schemas, defaults, labels, descriptions, and page order
- provider, model, reasoning, workspace, Browser, Terminal, Forge, and product
  policy
- typed validation beyond Longhorn's structural checks
- the mapping from accepted settings to Nucleus or Swallowtail behavior
- restart and activation consequences
- secret references and all credential resolution

The first product host is one sparse Settings dialog. Advanced configuration
stays behind its navigation and search rather than becoming permanent shell
chrome.

The current registry contains General, Appearance, Agent & models, Keybindings,
Storage, and Backups. Storage and Backups are capability-filtered operational
pages rather than invented preference documents. Project workspace layouts
remain project-scoped documents and are not global Settings defaults. Browser,
Terminal, and Forge keep their existing runtime and product policy, but receive
no Settings page until Nucleus defines a durable user-config schema and
activation consequence for a concrete preference. Read-only runtime status
alone is not a reason to create an empty settings page.

Nucleus may host multiple webviews in one native window. Its Tauri settings
adapter must therefore authorize a generic caller webview through its parent
window identity. It must not require the caller to be representable as a
single-webview `WebviewWindow`.

Multiple settings scopes may project one Nucleus config domain. A successful
write to that domain must invalidate every sibling scope that shares its
authority revision. Emitting only the mutated scope leaves cached drafts with
stale authority and is not conformant.

## Provider And Credential Settings

Provider configuration may expose provider instances, authentication posture,
model defaults, reasoning defaults, and repair actions. It must not expose or
persist raw credential material through Longhorn configuration.

OAuth, API keys, subscription sessions, and other credentials remain opaque
host-owned references under Contracts 004, 017, 027, and 030. Settings may
request an authorized setup or revocation workflow and present its sanitized
receipt. It may not read, copy, log, export, or infer credential values.

The renderer-safe credential projection keeps these axes separate:

- credential mechanism, such as interactive OAuth or API key
- entitlement or billing posture, such as subscription allowance or metered API
- credential ownership and resolution boundary
- optional opaque credential reference
- sanitized readiness and lifecycle-action availability

A provider-managed access profile with no credential reference must remain
reference-free. Nucleus must not invent a credential ref from an access-profile,
provider-instance, filesystem, or ambient-login identity.

Credential lifecycle requests carry only provider identity, action, and an
optional opaque reference matching the current projection. Setup, repair, and
revoke are separate actions. Each returns a coded sanitized receipt. When the
provider owns login lifecycle or no Nucleus credential reference exists, the
outcome is explicitly unavailable and no durable configuration changes. An
unavailable revoke must not imply that provider login was revoked.

Credential material is not a Settings value. It is excluded from Longhorn
documents, renderer state, events, logs, snapshots, backup archives, and
recovery payloads. Unknown request fields fail closed so a renderer cannot use
the lifecycle route as an accidental secret transport.

Changing provider, model, reasoning, resource, or harness mode cannot mutate
an immutable active Swallowtail session plan. It affects a newly prepared
session according to Contracts 010 and 030.

Provider/model Settings values are user-level defaults for a newly prepared
Agent Chat session. A stored conversation's selected and effective route stays
authoritative when reopened. Changing a default does not rewrite that route or
an in-memory live session. A later explicit composer selection remains a
session-scoped override. A configured model absent from current provider
discovery stays visibly unavailable; Nucleus does not silently replace it with
the first discovered model.

## Commands, Keymaps, And Palette

Longhorn may own product-neutral command registration, discovery, search,
argument shape, availability projection, physical-key resolution, sparse
keymap overrides, conflicts, and public palette bindings.

Nucleus owns every command's meaning, context facts, authorization, execution
route, product receipt, icon, and placement policy. A Longhorn command id is
not a Nucleus control-envelope command, bridge route, Tauri invoke name, or
permission grant.

Initial catalogue candidates include Settings, panel launch/focus, sidebar
selection, project/thread navigation, file quick-open, editor save, Forge
refresh, and active-turn cancellation. Existing component-local editing and
accessibility keys remain local unless their semantics are intentionally
promoted.

Nucleus command registration seals one immutable generation from a finite
inventory. The first inventory covers shell Settings, project management,
sidebar selection, current project/thread actions, panel launch and close,
editor quick-open and save, Forge refresh, and active-turn cancellation. Each
entry carries a stable `nucleus:` command id, a separate opaque
`nucleus.route.` product route, one closed argument schema, finite hot contexts,
required composed capabilities, and explicit discovery visibility. Dynamic
project ids, thread ids, file refs, and panel-instance ids remain in their
existing typed product workflows; they are not smuggled through unbounded
command arguments.

The hot-context tree is rooted at `global` and narrows through workspace,
project, panel, and the active Agent Chat, editor, or Forge panel. Capability
facts describe composed Nucleus mechanisms. Current selection, dirty-buffer,
Forge-readiness, and active-turn facts remain product state, not capabilities.

Catalogue and availability projections are advisory. Every invocation checks
the observed registry generation and closed arguments, reloads current Nucleus
context, capability, and product-availability facts, then resolves the admitted
opaque route into a typed Nucleus executor. A stale projection cannot authorize
execution. The typed domain route still performs its own current authority and
semantic checks. Renderer-local routes may execute locally only after the same
fresh admission.

No semantic command id becomes a Tauri invoke name, server command id, control
envelope kind, or string-dispatched domain action. Longhorn does not execute
Nucleus routes. Nucleus does not expose a generic command-to-Tauri bridge.
Component-local editing, IME, focus traversal, list-row selection, tab
accessibility, and confirmation-dialog behavior stay local unless a later
contract deliberately promotes one semantic action.

Nucleus registers one immutable `nucleus:default` keymap preset. Its initial
bindings are physical primary-modifier chords for Settings, editor quick-open,
and editor save. `primary` resolves to Meta on macOS and Control on Windows and
Linux; produced text is never a binding identity. Default bindings remain in
the preset. The user-config domain stores only active preset identity,
monotonic revision, and sparse disable, replace, or add directives at
`commands/keymap.json`.

The primary window is the only current caller admitted to catalogue and keymap
queries or mutation. Preview and commit bind registry generation, keymap
revision, preset version, and patch digest. Stale, invalid, conflicting,
unknown-command, and reserved-chord changes fail without publication. Reset
removes sparse directives and restores the compiled preset; it does not copy a
default map into user config. Current application and platform chords such as
macOS quit/hide/minimize/Spotlight, Windows lock, and Windows/Linux close stay
reserved from user overrides.

The runtime resolver receives current platform, hot-context path, repeat,
composition, editable-text, capture-mode, and reserved-chord facts. Repeat,
IME, text-input ownership, reserved input, capture, ambiguity, and unbound
input remain explicit outcomes. Only one resolved semantic invocation may be
consumed and sent through fresh Nucleus command admission.

Palette and keybinding UI should reduce visible chrome. It must not become a
generic string-execution bus or bypass host command policy.

## Async Operations

Longhorn may own a bounded cross-panel catalogue of queued, running,
cancelling, succeeded, failed, cancelled, and interrupted operations, including
generic progress, cancellation receipts, retry lineage, retention, and
renderer reconciliation.

Nucleus owns work admission, scheduling, resource locks, execution,
authorization, durable recovery, product detail, artifacts, logs, and terminal
evidence. Mapping a Nucleus runtime or receipt ref into a Longhorn operation
does not replace the Nucleus record.

Agent Chat activity, typed questions, provider plans, Tasks, Goals, work-item
state, transcript records, and runtime receipts remain in their current
domains. The generic catalogue may project bounded attention state across
panels; it must not flatten or duplicate those durable models.

First candidates are Forge network work, resource import, indexing, backup,
restore, provider setup, and other host work that may outlive its initiating
panel.

The desktop operation authority is `nucleus:desktop-operations`. Its admitted
kind ids are `nucleus:forge-inspection`, `nucleus:forge-mutation`,
`nucleus:forge-commit`, `nucleus:resource-import`, `nucleus:indexing`, and
`nucleus:recovery`. Current Forge inspection, staging, and commit commands are
the first live producers. These operations do not support cancellation because
their current executor boundaries cannot confirm interruption. A renderer may
observe, request supported cancellation, and dismiss retained terminal
projections; it may not register, progress, or terminate host work.

Operation projections may contain only operation identity, admitted kind,
optional project scope, bounded display label, generic progress, declared
cancellation support, retry lineage, and lifecycle state. Paths, resource
locators, status fingerprints, commit messages, receipts, provider payloads,
Task or Goal data, transcript content, and recovery artifacts remain in their
own Nucleus domains. The catalogue retains at most 64 active and 100 terminal
records under a one-mebibyte terminal metadata bound.

## Notifications

Longhorn may own a finite retained notification ledger, unseen/seen state,
dismissal, replacement, retention, checked clients, and transient Poodle toast
projection.

Nucleus owns which facts notify, wording, redaction, severity, actions,
authorization, and native-delivery policy. Notification actions are semantic
references resolved through fresh Nucleus command admission. Toast expiry is
not notification dismissal.

Normal presentation should be a small toolbar attention affordance plus
transient toasts. It must not add permanent diagnostic chrome or notify every
successful background action.

The desktop notification authority is `nucleus:desktop-notifications`. Current
publication admits failed cross-panel operations from the
`nucleus:operations` source. Routine success and progress remain silent.
Published records contain a bounded product label, generic failure summary,
optional project scope, opaque operation cause, severity, and an allowlisted
semantic action. They never contain paths, command output, commit messages,
fingerprints, provider payloads, credentials, or runtime receipts.

The host persists at most 100 records under a 512-KiB metadata bound. Seen and
dismissed state survives restart. Corrupt persistence is quarantined rather
than parsed as authority. The primary renderer may mark seen, dismiss, or
clear; it may not publish or replace records. `nucleus:sidebar.show-forge` is
the only current action reference and must rerun command-catalogue admission.
Toast selection is limited to warning, error, and critical records. Toast
expiry does not mutate the retained ledger.

## Backup, Restore, And Recovery

Nucleus may compose Longhorn's backup, restore, recovery, and settings
mechanisms over explicit Nucleus domain adapters.

Nucleus retains:

- SQLite online-snapshot policy
- domain inclusion and exclusion
- review-evidence retention and expiry
- editor-draft and local-layout policy
- credential and Browser-data exclusion
- destructive confirmation, recovery choice, and restart consequences

Backup and restore must never silently widen from desktop configuration into
project repositories, provider credential material, Browser cookies, raw
provider payloads, terminal streams, or expired review evidence.

The first backup catalogue admits exactly seven domains: the Nucleus SQLite
database, user preferences, command keymap, project layouts, panel
presentations, native-window placement, and the retained notification ledger.
SQLite capture uses its online backup API and validates the staged database
before archive publication. The file-backed domains capture one exact durable
document each. Missing optional documents remain absent rather than acquiring
synthetic defaults. Operational inventory is bounded to 1,024 scanned entries;
retention keeps the newest ten archives and revalidates a confirmation-bound
set of exact paths and digests before deletion.

Backup capture, bounded inventory, and host-selected export are active. The
renderer selects an inventoried archive by digest but never supplies a
filesystem destination. A Nucleus-owned asynchronous Tauri command opens the
native save picker before entering Longhorn's synchronous configuration
authority. The selected absolute path is retained as a bounded one-shot
capability keyed by the exact configuration request id, consumed once, and
cleared on cancellation, failure, or completion. Opening the picker never
holds the configuration authority mutex.

An existing path returned by the native save picker is explicit replacement
authority because the platform picker owns its overwrite confirmation. A path
that did not exist when selected receives refuse-overwrite authority, so a
later race cannot silently replace it. The authority re-lists the operational
root, revalidates the selected source digest, reads and inspects it within the
configured archive bounds, and uses Longhorn's canonical user-export
re-encoding and verified publication. It does not recapture current state,
copy an operational archive unchanged, or implement a second ZIP codec.

Restore publication never runs inside the live renderer process. The live
SQLite authority is held by `DesktopState`; file-backed domains are also opened
by window, command, Settings, workspace, and notification services. A restore
request therefore binds one inspected archive, the exact seven-domain
selection, and Longhorn's grouped confirmation into a durable Nucleus restart
request. Persisting that request grants only boot execution authority. It does
not mutate a domain or claim completion.

Longhorn owns the grouped custom-adapter transaction, private stage material,
journal, stable apply order, reverse rollback, terminal classification, and
boot recovery. Every Nucleus adapter declares
`GroupedFailureAtomic`, stages target and exact prior-state payloads without
mutation, applies only Longhorn-supplied durable payloads, and independently
verifies semantic evidence. File domains publish one exact document through
atomic replacement. The SQLite domain stages and publishes through SQLite's
native backup API; copying the main database, WAL, or shared-memory files is
forbidden.

Nucleus owns the restart request and boot boundary. The request records the
storage-layout digest, archive path and digest, exact domain ids, group
confirmation, and request state. It is written durably before restart is
requested. On the next launch, after storage-profile resolution and directory
preparation but before workspace, window, command, notification, Settings,
bridge, terminal, server, or database authorities open, Nucleus reconstructs
the exact domain descriptors and adapter catalogue. It first calls Longhorn
group recovery. Recovery failure keeps product authorities closed and remains
actionable on the next launch.

After terminal recovery, a pending request is re-inspected and re-planned from
the selected archive. Layout, archive, domain, adapter, evidence, or
confirmation drift rejects execution without mutation. A matching request is
executed once through Longhorn's grouped API. Nucleus clears the request only
after a committed or completely rolled-back terminal receipt is durably
recorded. An interrupted or recovery-required operation retains enough state
for the next boot to invoke Longhorn recovery before any product authority
opens.

Settings exposes that last durable boot receipt as read-only recovery status.
It may report committed, rejected, or rolled-back truth, but it cannot retry,
alter, or reinterpret the grouped transaction.

Nucleus must not reproduce Longhorn's journal, rollback, archive, or grouped
transaction vocabulary. A grouped custom-adapter target must use Longhorn's
explicit `BackupAdapterStateEvidence` for both target and rollback state.
Archived absence carries zero payloads, restores as deletion inside the same
transaction, and verifies as absent. Present evidence carries semantic SHA-256
and at least one payload. Omitting an absent domain or publishing a synthetic
payload is forbidden.

Restore capabilities may be advertised only while the restart request, boot
coordinator, exact seven-domain adapters, explicit target/rollback evidence,
and deterministic restart/recovery fixtures remain installed. Unsupported
restore commands continue to return explicit rejections. Native destructive
acceptance uses an isolated state root and remains a separate operator gate.

## Optional Backend Bridge

Longhorn's bridge may standardize session identity, host form, capability,
domain authority, connection state, event ordering, bounded retry,
idempotency, and stale-session invalidation.

Nucleus retains its typed control envelopes, domain DTOs, host selection,
pairing policy, authentication, endpoint admission, command authorization,
and product authority maps. No second generic payload vocabulary is allowed.

The first bridge adoption may prove direct and Tauri-local semantic parity.
Production HTTP, WebSocket, Unix-socket, named-pipe, discovery, provisioning,
update, authentication, and remote lifecycle work remains blocked until
Nucleus promotes its remote host pairing/session contract. Longhorn currently
provides no production transport claim for those edges.

The local bridge exposes one `nucleus.control` domain over the same
`TauriIpcControlCommandAdapter` used by the existing desktop control path.
Query and command routes carry the existing typed
`ControlRequestEnvelopeDto`; bridge and Nucleus request identifiers must match
exactly. Capability disclosure, read authority, and write authority remain
separate. Each hello creates a new local session and invalidates the previous
caller session. Bridge-level revision or idempotency evidence is rejected
because Nucleus command DTOs do not provide one uniform safe mapping for it.
Rejected Nucleus outcomes remain typed rejected bridge outcomes, and uncertain
writes are never retried by this adapter.

## Cross-Window Transfer

Surface-free direct-window transfer may be adopted only after Nucleus defines
a real secondary workspace-window product shape. The transfer session,
complete target lease, measured geometry, and authoritative panel move may
come from Longhorn. Nucleus retains window roles, panel catalogue, project
scope, panel bodies, resource bindings, and close/recovery policy.

The existing primary window and project layout must not gain dormant Surface
state or hidden secondary-window assumptions before that product gate.

## Explicit Deferrals

The following are not current Nucleus adoption lanes:

- hosted Longhorn Surfaces
- generic Longhorn history for CodeMirror editing, Tasks, agent transcripts,
  SCM history, or runtime receipts
- native isolated-window or backing-surface content without a concrete panel
  requirement
- native OS notifications without privacy, permission, focus, and redaction
  policy
- generic offline mutation queues

CodeMirror owns editor-local undo. Nucleus owns task timelines, runtime
receipts, SCM history, and durable product events. Longhorn history may be
reassessed only for a new bounded structural history that lacks an existing
authority.

## Validation

Each adopted system requires:

- direct deterministic domain fixtures before native proof
- Rust/TypeScript compatibility checks where both sides participate
- listener-before-snapshot and stale-result tests
- remount, project-switch, restart, and teardown evidence where relevant
- exact capability and dependency audits
- focused Effigy selectors and docs QA
- a separately gated native pass for system or credential effects

The pre-existing Doctor oversized-file baseline is tracked separately. New
integration work must not worsen it.
