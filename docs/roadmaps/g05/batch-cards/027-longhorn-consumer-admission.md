# 027 Longhorn Consumer Admission

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../009-longhorn-secondary-system-admission.md`
Depends on: card 026
Auto-start next card: yes

## Objective

Freeze the exact Longhorn consumer boundary before Nucleus adopts another
shared desktop system.

## Acceptance

- [x] inventory every current Longhorn package, source revision, and Nucleus adapter
- [x] record package-versus-product authority for each admitted mechanism
- [x] prove one Svelte runtime and one Poodle runtime in the produced desktop graph
- [x] identify the focused module edge for each proposed secondary system

## Validation

- [x] focused dependency and artifact inspection passes
- [x] docs QA and scoped diff hygiene pass

## Stop Conditions

- stop if the selected Longhorn source is dirty or cannot produce exact artifacts
- do not begin a secondary-system implementation from source-tree imports

## Evidence

- selected Longhorn source commit: `976a40875408cfd9547aad519ce4463ed3ac8494`
- selected-tree SHA-256:
  `4aa8a8025a1357df697e899f55b77c2796429d303632480e8fcb86c7d3393c96`
- unrelated Loophole docs/script changes were outside the selected source tree
- `effigy check:longhorn-consumer` packed six Longhorn renderer artifacts,
  installed them with Poodle artifact set
  `39f08c04fa2579ae709db412c28221c04f22b89f09e633cef93764e5d49f8c74`,
  and proved one Svelte and one Poodle runtime
