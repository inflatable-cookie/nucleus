# 006 Kimi Adapter Readiness Research

Status: completed-first-pass
Owner: Tom
Updated: 2026-06-15

## Goal

Promote Kimi from first-pass runtime dossier to adapter implementation
readiness.

## Scope

- Re-check Kimi CLI ACP behavior.
- Compare SDK sidecar capabilities against ACP gaps.
- Record session, turn, tool-call, approval, status, and interruption evidence.

## Out Of Scope

- Implementing Kimi support.
- Defaulting to auto-approval or YOLO mode.
- Assuming SDK sidecar is needed before ACP evidence is complete.

## Evidence Questions

- Does `kimi acp` expose enough event identity and approval fidelity?
- Which SDK events are missing from ACP?
- How are sessions listed, resumed, parsed, and interrupted?
- How should MCP configuration be represented in adapter registry records?
- Which capabilities must be marked partial or unknown?

## Stop Conditions

- ACP identity is insufficient and SDK sidecar viability is unproven.
- Approval/tool-call ids cannot be preserved.
- Auto-approval would be required for normal operation.

## Promotion Targets

- `docs/research/specimen-dossiers/kimi-runtime-boundary.md`
- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```
