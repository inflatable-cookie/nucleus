# 087 Compile Local Request Handler Runway

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Compile the next implementation runway after Tauri readiness reassessment.

## Scope

- Decide whether Tauri can start now.
- If not, identify the server boundary still blocking it.
- Create the next active roadmap and ready cards.
- Stay inside `g01`.

## Out Of Scope

- Implementing request handling.
- Scaffolding Tauri.
- Selecting final network transport.
- Adding command execution.

## Decisions

- Tauri should not start yet.
- Local control request handling is the next blocking server lane.
- Transport selection should remain readiness vocabulary until request
  handling is testable.
- The next ready card is `088-add-local-control-request-handler-skeleton.md`.

## Closeout

Created roadmap `008-local-request-handling-and-transport-readiness.md` and
made card `088` ready.
