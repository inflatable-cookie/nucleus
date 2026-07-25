# Swallowtail Application Proof Readiness

Date: 2026-07-25
Status: planned behind active desktop work

## Change

Swallowtail's first publication is held until Nucleus proves the library
through sustained normal-path application use.

The readiness audit found two missing native capabilities:

- desktop state is fixed under `~/.nucleus`
- Agent Chat cannot cancel an active turn through its normal UI/Tauri path

The current chat runtime also collapses cancellation and deadline errors into
the generic failed persistence path. Lower-level Swallowtail smoke and task
cancellation do not substitute for product-path evidence.

## Promoted Decisions

- `NUCLEUS_DESKTOP_DATA_ROOT` isolates database, review snapshots, and UI
  config without changing `HOME` or provider configuration.
- the normal 180-second turn deadline stays default; a bounded process-start
  proof setting uses the same Swallowtail deadline mechanism
- native Agent Chat gets one active-turn Cancel action
- cancellation control stays outside the serialized chat-service mutex
- durable turn state distinguishes completed, cancelled, timed out, and failed
- Effigy launches the isolated native profile and exposes sanitized evidence
- deterministic readiness makes no provider call

Spec 014 is promoted into Contracts 008, 010, and 030, architecture, and
roadmap g05.003, then archived.

## Current State

- Nucleus posture: `strict-ready`
- current ready work: g05 card 006 sidebar validation
- Swallowtail proof cards 007-010: planned
- card 007 cannot start while the active sidebar work modifies the same Tauri,
  Agent Chat, and server files
- live Codex calls: not authorized
- current user code changes: preserved

## Next Move

Complete and checkpoint card 006. Then execute cards 007-009 as one
credential-free readiness batch. Card 010 returns the exact live pilot for
separate approval.
