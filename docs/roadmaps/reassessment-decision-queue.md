# Reassessment Decision Queue

Status: proposed
Owner: Tom
Updated: 2026-06-17

## Purpose

List the decisions that must be made before Nucleus leaves the current
reassessment pause.

This is not a new generation. It is the gate for deciding whether `g01`
continues or closes at a real switch-gear point.

## Current Posture

Strict-paused.

Reason:

- product direction is broad and mostly captured
- proof implementation has advanced far enough to reveal structural pressure
- the next implementation lane would make core architecture decisions by
  accident unless these choices are made first

## Decision 1: Orchestration Model

Question:

- Is Nucleus built around event-sourced orchestration, or record state plus an
  append-only audit trail?

Decision:

- adopt an event-sourced orchestration spine for tasks, sessions, runtime
  receipts, checkpoints, and SCM operations

Reason:

- Nucleus needs replay, projection, multi-client reconciliation, host handoff,
  provider runtime ingestion, and durable task history
- T3 Code already demonstrates that provider runtimes, checkpointing, and
  UI projections become cleaner when commands/events/projections are explicit
- record-only mutation is likely to become brittle once harnesses, worktrees,
  steward actions, and shared project projections interact

Decision output:

- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- new Rust crate or crate split plan still needed
- migration rule for current project/task command paths still needed

## Decision 2: Engine Boundary

Question:

- Should `nucleus-server` keep growing as the implementation center, or should
  an engine/orchestration crate own domain commands and projections?

Decision:

- create both `nucleus-orchestration` and `nucleus-engine` before real provider
  runtime work

Reason:

- local embedded desktop, sidecar daemon, remote authoritative host, and
  remote worker host all need the same domain rules
- `nucleus-server` should be a host/API wrapper, not accidental system core

Decision output:

- `docs/contracts/022-engine-orchestration-boundary-contract.md`
- `docs/architecture/engine-orchestration-boundary.md`
- first migration target from `nucleus-server` still needed

## Decision 3: Generation Boundary

Question:

- Does this reassessment pause close `g01`, or does `g01` continue with a
  cleanup/orchestration tranche?

Allowed answers:

- continue `g01` if the next work is still foundation repair
- start `g02` if the next work shifts from bootstrap/proof surfaces into core
  orchestration implementation

Non-rule:

- generation size alone is not a reason to roll over

Decision output:

- roadmap front door points at either the next `g01` tranche or `g02`
- no parallel "maybe next" lanes

## Decision 4: Authority Document Split

Question:

- Which broad documents need to be split before they can govern more code?

Recommended default:

- split the server boundary contract into narrower contracts
- keep `system-architecture.md` as a summary front door, with detailed records
  moved into focused architecture docs

Immediate split candidates:

- orchestration contract
- conversation timeline contract
- runtime receipt and progress event contract
- checkpoint and diff contract
- remote host pairing/session contract
- tool broker and MCP/preview contract
- observability contract

Decision output:

- contract split plan
- updated contract index
- reduced ambiguity in `007-server-boundary-contract.md`

## Decision 5: First Product Workflow Proof

Question:

- Which workflow proves Nucleus is more than a T3-style harness shell?

Recommended candidates:

- task-backed agent work unit with durable timeline and receipts
- repo-backed project-management projection with steward-assisted sync
- SCM worktree/change-request workflow tied to task execution

Recommended default:

- task-backed agent work unit, because it forces orchestration, timeline,
  receipts, provider runtime, SCM checkpoint, and project authority decisions
  into one coherent slice

Decision output:

- one workflow chosen
- acceptance criteria stated before implementation
- UI remains proof-only until the workflow model is real

Current follow-on:

- task-backed agent work-unit proof is now implemented through source records,
  runtime admission fixtures, review evidence, and read-only desktop progress
  DTOs
- next workflow selection moves to repo-backed management sync hardening so
  project/task state can become a reliable committable surface

## Decision 6: First Runtime Target

Question:

- Which provider/runtime should prove the harness layer after the core model is
  ready?

Candidates:

- Codex
- Claude Code CLI/PTTY
- OpenCode/ACP
- Cursor SDK or CLI
- Nucleus-native steward persona

Recommended default:

- defer the provider choice until orchestration and timeline contracts exist
- keep OpenCode/ACP and Nucleus-native steward as the likely first comparison
  pair because they test both bridged and app-owned runtime shapes

Decision output:

- first runtime target
- reason it exercises the right adapter risks
- explicit non-goals for other providers

## Decision 7: Health Gate

Question:

- Must `effigy doctor` be clean before the next implementation lane?

Recommended default:

- yes, for the current high god-file failure
- no, for every warning, but warnings should be paid down when touching those
  areas

Decision output:

- split `crates/nucleus-command-policy/src/storage_codec.rs`
- leave warning file list as implementation-pressure evidence

## Suggested Decision Order

1. orchestration model
2. engine boundary
3. authority document split
4. generation boundary
5. first product workflow proof
6. first runtime target
7. health gate sequencing

## Next Planning Output

After these decisions, create exactly one of:

- a `g01` continuation tranche if this remains foundation repair
- a `g02` generation front door if the project shifts into orchestration
  implementation
