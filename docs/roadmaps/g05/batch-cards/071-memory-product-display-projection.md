# 071 Memory Product Display Projection

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../023-memory-provider-and-advanced-control-cohesion.md`
Depends on: card 070
Auto-start next card: yes

## Objective

Carry useful bounded Memory titles and summaries through the existing
project-scoped read model without exposing restricted content or creating a
second Memory vocabulary.

## Acceptance

- [x] Contract 013 defines product display bounds and sensitivity redaction
- [x] public-project and internal-project records expose stored sanitized title and summary
- [x] user-private, secret-adjacent, and restricted content is omitted and marked redacted
- [x] list projections never expose detail, review notes, source payloads, or raw provider material
- [x] truncation and redaction remain explicit in Rust and serialized DTOs

## Validation

- [x] focused accepted-memory, proposal, DTO, and binding fixtures pass
- [x] generated TypeScript bindings match the Rust response shape

## Stop Conditions

- do not add viewer authorization or mutation semantics in this card
- do not infer content from ids, refs, tasks, transcripts, or provider payloads

## Evidence

- `crates/nucleus-server/src/memory_display.rs` owns bounded sensitivity-safe
  display projection without changing the stored Memory vocabulary.
- accepted-memory and proposal projections carry explicit title, summary,
  redaction, and truncation fields while excluding detail.
- focused projection, query, response DTO, and 288 binding-export fixtures pass.
- `effigy check:rust` passes.
