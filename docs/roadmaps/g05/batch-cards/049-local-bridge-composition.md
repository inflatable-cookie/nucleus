# 049 Local Bridge Composition

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../016-optional-backend-bridge-alignment.md`
Depends on: card 048
Auto-start next card: no

## Objective

Prove listener-first direct and Tauri-local bridge sessions expose equivalent
connection and authority truth.

## Acceptance

- [x] direct and Tauri-local paths share one handler assembly and authority
- [x] reconnect, incompatible, unauthorized, and offline states remain distinct
- [x] uncertain writes are not retried silently
- [x] loopback evidence makes no production remote-support claim

## Validation

- [x] focused direct, serialized-loopback, stale-session, and teardown fixtures pass
- [x] consumer-native Tauri invocation proof passes

## Evidence

The production Tauri commands and direct tests share the exact
`BridgeHandlerAssembly` and existing desktop control adapter. The consumer
fixture now builds a mock runtime with Nucleus's real generated Tauri context,
invokes the registered `longhorn_bridge_hello` and `longhorn_bridge_query`
commands from the admitted `main` webview, and matches the direct receipt and
reply exactly. The empty mock context is intentionally not used because it
contains no application capability authority. No application-wide explicit
command ACL was introduced as a side effect.

## Stop Conditions

- stop before production remote transport selection
