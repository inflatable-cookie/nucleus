# Repository Authority Map

Status: active
Owner: Tom
Updated: 2026-08-01

## Ownership

| Repository | Owns | Does not own |
| --- | --- | --- |
| Nucleus | projects, resources, tasks, Goals, mandates, work items, host selection, prompts, evidence, review, receipts, persistence, UI | shared provider process/protocol mechanics after adoption |
| Longhorn | desktop storage profiles and transitions, display and window mechanics, registered layout mechanics, native-content coordination | Nucleus product records, panel catalogue, project scope, Browser policy, or visual primitives |
| Poodle | visual primitives, public component bindings, overlay geometry events | desktop persistence, layout authority, native windows, or native child content |
| Swallowtail | portable runtime policy, preflight, host-service contracts, provider adapters, normalized events, callbacks, deadlines, cleanup | Nucleus domain authority, scheduling, persistence, or product consequences |
| Soundcheck | audio-plugin taxonomy, tagging prompts/schema, review, product state | shared provider connector mechanics |
| Monkey | local model serving and execution behavior | Nucleus workflow or Swallowtail portable policy |

## Dependency Direction

Nucleus may depend on Swallowtail crates. Swallowtail must not depend on
Nucleus crates, import Nucleus records, or use this repository as runtime
configuration. Cross-repo evidence becomes Swallowtail behavior only after it
is promoted in Swallowtail's own architecture and contracts.

Nucleus may depend on Longhorn mechanism packages and Poodle visual packages.
Longhorn and Poodle must not depend on Nucleus. Surface hosting is not part of
the Nucleus composition: the workspace hierarchy is `display -> window ->
region -> panel`, with project layouts and panel presentations retained as
Nucleus product adapters over Longhorn's registered layout document.

## Task-Execution Seam

Nucleus selects the execution host, resource, model route, expanded access
policy, prompt, deadline, and product consequence. Swallowtail validates and
executes exactly that portable policy through the host services belonging to
the selected execution host.

Swallowtail returns normalized observations, opaque provider refs, terminal
state, and cleanup state. Nucleus maps them into work-item waiting, completion,
failure, or recovery records and owns every checkpoint, diff, review, receipt,
and lifecycle transition.

No filesystem path, renderer authority, task id, receipt id, or mutable product
record becomes a Swallowtail configuration value.
