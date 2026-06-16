# Architecture

Architecture records the system shape once planning starts to settle.

## Current Architecture Artifacts

- `system-architecture.md`
- `system-inventory.md`
- `product-guardrails.md`

## Open Questions

- Which harnesses should be SDK-first, ACP-first, or CLI/PTY-first?
- Which server API style should back desktop, web, mobile, and CLI clients?
- Which storage engine should hold project, task, workspace, and session state?
- Which repo projection path should hold shared project management state?
- What authority should the project steward agent have during Git sync?
- Should the Nucleus-native harness be pure Rust, Pi-backed, or sidecar-backed?
- Which local model backend should support steward personas first?

## Next Task

Draft management projection file model.
