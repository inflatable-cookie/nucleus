# 010 Floating Agent Chat Composer

Status: completed
Owner: Tom
Updated: 2026-07-13

## Intent

Replace the basic Agent Chat footer with a quiet floating composer inspired by
T3 Chat. Keep the workflow visually simple while putting turn-level model and
reasoning choices at the send boundary.

## First Shape

- one centered floating composer over the bottom of the timeline
- borderless auto-growing message field
- compact model and reasoning selectors in a lower toolbar
- round send control at the far edge
- selected Goal and Task as removable compact context chips
- errors attached to the composer without a permanent help footer
- enough timeline bottom inset that content never hides behind the composer

Model and reasoning controls must be real. Options come from the local Codex
provider catalog, the server validates/forwards the chosen route on the turn,
and the durable chat session records the effective route.

## Non-goals

- attachments, permissions, build-mode, branch, or task-mode controls
- a large settings bar or IDE command strip
- streaming redesign
- per-project route policy or cost accounting
- copying T3 Chat branding or its whole composer footer

## Checkpoint

The operator accepted the functional visual slice after spacing, alignment,
control-size, placeholder, and menu-density tuning.
