# 027 Provider Auth Forge Execution Contract

Status: draft
Owner: Tom
Updated: 2026-06-21

## Purpose

Define the authority boundary for real forge provider auth and network-backed
forge execution.

This contract governs the step after stopped pull-request request preparation.
It allows future implementation to model provider credentials and network
effects without accidentally granting broad forge writes, callback execution,
task mutation, recovery mutation, or raw-provider-payload retention.

## Governing Refs

- `011-scm-forge-sync-contract.md`
- `017-engine-host-authority-contract.md`
- `020-runtime-receipt-contract.md`
- `022-engine-orchestration-boundary-contract.md`
- `023-task-backed-agent-workflow-contract.md`

## Authority Rule

Provider auth and forge execution require separate authority checks.

A request may not execute against a provider unless all applicable authority
domains are satisfied:

- project authority
- source authority where source refs are read or linked
- SCM/forge authority for the target repo or provider object
- credential authority for the credential ref being resolved
- network authority for outbound provider API calls
- operator approval for mutating effects
- audit/evidence authority for persisted receipts and evidence

Having one domain does not imply another. A valid credential ref does not grant
network write authority. A prepared PR request does not grant PR creation. A
PR creation approval does not grant merge, comment, label, reviewer, or branch
mutation authority.

## Credential Ref Rule

Nucleus records credential refs and sanitized credential-use evidence, not raw
credential material.

Credential refs may describe:

- credential ref id
- provider kind
- account, organization, installation, or host scope where safe
- repo or forge scope where safe
- credential kind
- resolution boundary
- allowed operation families
- expiry or rotation status where safe
- repair state

Credential refs must not contain:

- access tokens
- authorization headers
- cookies
- SSH private keys
- provider-native auth files
- credential helper output
- webhook signing secrets
- raw provider error payloads

Credential material is resolved only through the authoritative host credential
boundary. Adapters may request credential refs; they must not store, rotate,
prompt for, or log credential material.

## Credential Status

Provider auth work reports sanitized status.

Initial statuses:

- unresolved
- ready
- expired
- revoked
- permission denied
- requires user action
- unsupported
- missing scope
- provider unavailable
- repair required
- unknown

Credential failures may create repair work or review evidence. They must not
copy provider error payloads unless sanitized under artifact policy.

## Provider Context

Provider execution must bind to explicit provider context.

Minimum context:

- project id
- repo id
- forge provider instance id
- provider kind
- provider host or service ref
- provider account, owner, organization, or installation ref where safe
- remote repo ref
- target object family
- requested operation family
- authority host id

Provider context is not inferred from a filesystem path alone. Git remotes,
repo metadata, and forge observations may help resolve context, but the final
execution request must name the provider instance and target refs.

## Effect Families

Forge provider effects are grouped by family. Authority is granted per family.

Initial read families:

- provider auth status refresh
- repository metadata refresh
- pull-request or merge-request refresh
- issue refresh
- comment refresh
- review workflow refresh
- status/check refresh

Initial mutating families:

- pull-request or merge-request create
- pull-request or merge-request update
- comment create
- review request update
- label or metadata update
- status/check create or update

Deferred mutating families:

- merge
- close without review outcome
- branch protection mutation
- repository setting mutation
- force push
- destructive branch deletion
- provider permission mutation

Deferred families need separate admission records before implementation. A PR
create lane must not silently grant merge or repository-setting authority.

## Admission Record

Every provider-auth or forge-execution attempt starts with an admission record.

Minimum fields:

- admission id
- project id
- repo id
- forge provider instance id
- provider kind
- operation family
- read or mutating effect class
- source evidence refs
- target provider refs
- credential ref ids
- network authority ref
- operator approval ref for mutating effects
- idempotency key
- retry policy ref
- recovery policy ref
- sanitization policy ref
- requested by actor ref
- authority host id
- blocked reasons
- status

Admission status must be visible to clients. Blocked admission is a valid
outcome and should include sanitized repair hints.

## Preflight Rule

Mutating provider effects require preflight before execution.

Preflight must check:

- provider context resolved
- credential refs present and allowed for the operation family
- credential status ready or explicitly repairable
- network authority granted for the provider endpoint
- operator approval present and current
- target repo/object ref still matches the prepared evidence
- idempotency key present
- retry and recovery policy present
- raw provider payload retention disabled unless separately approved
- operation family is supported by the adapter
- effect is not in a deferred family

Preflight may produce sanitized evidence. It must not call mutating provider
APIs unless it is itself an admitted provider effect.

## Network Execution Rule

Network-backed forge execution runs only through a server-owned execution
boundary.

The execution boundary owns:

- network permission
- credential material resolution
- timeout policy
- retry scheduling
- idempotency reconciliation
- receipt creation
- sanitized provider response evidence
- artifact retention decisions

Adapters own provider translation and capability reporting. They do not own
network authority, credential storage, retry loops, receipt persistence,
task mutation, or event fan-out.

## Idempotency Rule

Every mutating provider request needs an idempotency key.

The idempotency key should be derived from stable non-secret refs:

- project id
- repo id
- provider instance id
- operation family
- target provider refs
- source evidence refs
- operator approval ref
- prepared request ref

Retries use a new effect request id linked to the original idempotency key and
prior receipt. A duplicate or uncertain write must reconcile against provider
state before attempting another mutation.

## Provider Response Evidence

Provider responses become sanitized evidence.

Allowed by default:

- provider object refs
- provider request id where safe
- provider URL where policy allows
- status code class
- rate-limit or retry-after class
- ETag or version refs where safe
- created or updated object ids
- short sanitized summary
- retry classification
- recovery classification

Blocked by default:

- raw response body
- raw request body
- raw headers
- authorization material
- cookies
- full provider error payloads
- raw diff or patch payloads
- raw PR title/body text unless already stored as an approved artifact ref

Raw payload retention requires explicit artifact policy, access checks, and a
separate approval path.

## Receipt Rule

Provider-auth and forge-execution effects produce runtime receipts.

Receipts must include:

- receipt id
- admission id or effect request id
- operation family
- authority host id
- credential-use evidence refs
- provider response evidence refs
- status
- retry refs
- cancellation refs where applicable
- recovery refs where applicable
- sanitized summary

Receipt replay must not re-run network calls.

## Read-Intent Control Boundary

Provider read-intent surfaces are read-only evidence projections.

Current represented read families:

- credential-status refresh
- repository metadata refresh
- pull-request or merge-request refresh

The generic provider read-intent projection may aggregate persisted stopped
records across these families. It may expose:

- stable intent ids
- family
- status
- provider, repo, and credential refs where sanitized
- blocker counts
- evidence-ref counts
- source record counts
- explicit no-effect flags

It must not expose:

- credential material
- raw provider payloads
- raw request or response bodies
- raw headers
- raw PR title/body text unless referenced as approved artifacts
- provider-native auth files
- live provider handles

Provider read-intent queries may be available through the in-process server
control API before they are available through a serialized control envelope.
Serialized envelope support requires a deliberate DTO contract. The DTO must
not be inferred automatically from internal Rust structs.

The first serialized provider read-intent DTO should be read-only and
client-safe:

- one explicit query action for the aggregate projection
- aggregate counts and source counts
- optional sanitized entry summaries by reference
- explicit no-effect flags
- unsupported codec errors for shapes outside the planned DTO

Adding serialized read-intent DTOs does not grant credential resolution,
provider network calls, provider effects, callbacks, interruption, recovery,
task mutation, raw-material retention, or additional read-family fan-out.

## Provider Live Read Execution Delta

Live provider reads require a separate stopped execution boundary after
fixture-backed admission and persistence.

Allowed before live access:

- credential lease metadata refs
- network-read authority refs
- fixture client refs
- provider read capability records
- stopped executor handoff records
- sanitized fixture response records
- sanitized fixture error records
- rate-limit, retry, cancellation, and response evidence refs
- diagnostics and read-only control DTOs

Credential lease metadata may name the lease ref, provider family, scope, and
expiry class where safe. It must not contain credential material.

Provider read capability records should expose differences instead of hiding
them. They may state supported operation families, conditional request support,
rate-limit metadata support, cancellation support, provider-specific limit
refs, and whether a credential lease is required.

Stopped live-read handoffs must be built from persisted live-read planning
records. They must carry sanitized request refs, capability refs,
credential-lease refs, network-read authority refs, fixture-client refs,
sanitization refs, and evidence refs.

Fixture responses may record:

- sanitized response summary refs
- sanitized response evidence refs
- provider status class refs
- provider error class refs
- retry hint refs
- rate-limit refs
- cancellation refs

Blocked until a later explicit approval gate:

- real credential material resolution
- real provider network calls
- raw request or response body retention
- raw headers or authorization material
- provider writes
- task mutation
- callback, interruption, or recovery execution

Adding the stopped live-read execution boundary does not authorize a smoke
against GitHub, GitLab, Cursor, or any other provider. A live smoke needs a
separate operator-approved lane naming provider, repo, credential lease,
network authority, payload policy, retention policy, and expected evidence.

## Provider Readiness Overview

The first product consumption surface for provider read-intent should be a
server-owned Provider Readiness Overview projection.

Purpose:

- answer whether a project/repo/provider appears ready for forge-backed work
- show what is missing before provider reads or writes can run
- give desktop, CLI, and future web/mobile clients one client-safe surface
- avoid designing visible UI before the server projection is useful

Allowed inputs:

- provider read-intent projection entries
- provider context refs
- credential-status evidence refs
- repository metadata evidence refs
- pull-request or merge-request refresh evidence refs
- sanitized blocker/status counts

Allowed output:

- overview id
- project, repo, provider, and authority host refs where sanitized
- readiness status: ready, blocked, needs repair, unknown, unsupported
- supported read families by name
- represented mutating families by name
- blocker counts grouped by authority domain
- missing evidence family counts
- sanitized repair hint refs
- explicit no-effect flags

The overview must not expose credential material, raw provider payloads, raw
request or response bodies, raw headers, provider-native auth files, live
provider handles, or provider object content that has not been approved as an
artifact.

The overview is not a provider refresh. It must be composed from already
persisted local evidence unless a separate refresh lane grants provider read
authority. It must not silently fan out into issue, comment, review workflow,
or status/check refresh families.

Visible UI may consume the overview later, but the first implementation should
prove the server projection and control boundary before adding panels.

## Provider Readiness Overview Client Surface Rule

Clients may render Provider Readiness Overview only as a read-only view over
the serialized overview DTO.

Allowed visible fields:

- overview id and projection id
- readiness status
- sanitized project, repo, provider, remote repo, and authority-host refs
- supported and represented read-family names
- represented mutating-family names as capability context only
- total read-intent count
- ready, blocked, repair-required, duplicate-noop, blocker, evidence, and
  missing-evidence-family counts
- explicit no-effect flags

Allowed read-only drilldowns:

- provider read-intent projection
- persisted credential-status evidence summaries
- persisted repository metadata evidence summaries
- persisted pull-request or merge-request refresh evidence summaries
- root CLI or Effigy inspection commands that already expose the same
  sanitized data

Blocked from the visible overview surface:

- live provider refresh
- credential resolution
- provider network calls
- provider write preparation or execution
- callback, interruption, or recovery execution
- task mutation
- raw provider payload display
- raw request or response body display
- raw headers or authorization material
- provider-native auth files or live provider handles

The first visible surface should prove that a client can consume and render the
overview without gaining authority. It must not add another read family,
perform live refresh, or start provider-effect admission.

## Callback And Webhook Split

Outbound provider execution and inbound provider callbacks are separate lanes.

Webhook verification may create normalized observations after verification.
It does not grant outbound provider write authority.

Outbound forge execution may create provider objects. It does not grant
webhook endpoint authority, callback handling, task mutation, or automatic
review-state mutation.

## Task Mutation Split

Provider effects do not mutate task state directly.

A successful forge effect may create:

- normalized forge observations
- provider object refs
- review workflow refs
- task-link proposals
- runtime receipts
- repair or follow-up suggestions

Task state changes require task-backed workflow admission under the task and
orchestration contracts.

## Recovery Rule

Recovery is evidence-first.

If a provider request times out, crashes, or returns an uncertain result,
Nucleus must not blindly retry the mutation. It should:

- record the uncertain receipt
- retain the idempotency key
- refresh provider state where allowed
- reconcile provider object refs where possible
- produce recovery-required state when reconciliation is not enough
- require operator review before repeating a mutating effect

Adapters may classify recovery outcomes. The authoritative host owns recovery
state, retry scheduling, and receipts.

## Initial Implementation Gate

The first implementation after this contract should be stopped by default.

Allowed:

- provider-auth admission records
- forge-network execution admission records
- credential ref status records
- network-authority request records
- sanitized preflight records
- read-only control DTOs
- diagnostics
- tests proving blocked writes and sanitized evidence

Blocked:

- real credential material resolution
- real provider network calls
- pull-request creation
- comment creation
- merge
- callback/webhook execution
- task mutation
- raw provider payload retention

Real provider network writes require a later explicit lane after stopped
admission, preflight, receipts, idempotency, and recovery surfaces are proven.

## Live Read Executor Rule

The first live provider read is narrower than provider execution generally.

Allowed for repository metadata refresh:

- approved smoke-derived executor request records
- fixed read-only command descriptors such as field-limited `gh repo view`
- sanitized selected-field output records
- runtime receipts that state whether a provider network read occurred
- diagnostics and read-only control DTOs

Still blocked:

- credential material persistence
- raw provider stdout, stderr, headers, or response-body retention
- provider writes
- task mutation
- callback/webhook execution
- interruption/recovery execution
- automatic UI-triggered provider execution

The control surface may inspect executor diagnostics. It must not become an
implicit grant to perform broader provider reads or writes.

## Test Obligations

Contract-backed tests should prove:

- credential refs cannot carry raw credential material
- network writes are blocked without network authority
- mutating effects are blocked without operator approval
- deferred effect families are blocked
- admission records retain idempotency keys
- retries link to prior receipts instead of reusing the same effect id
- provider response evidence is sanitized
- task mutation is not implied by provider success
- callback/webhook authority is not implied by outbound provider execution

## Open Questions

- Which forge provider is first for live network testing: GitHub, GitLab, or a
  local fake provider?
- Should the first real provider write create draft pull requests only?
- Should provider URLs be exposed to every client or gated by project policy?
- Which credential backend is first: host credential provider, server secret
  store, or provider-native auth?
- Which provider response payloads deserve artifact retention support?
