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
