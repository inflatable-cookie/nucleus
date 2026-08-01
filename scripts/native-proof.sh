#!/bin/sh
set -eu

proof_root=${NUCLEUS_DESKTOP_PORTABLE_ROOT-}
case "$proof_root" in
  /*) ;;
  *) echo "NUCLEUS_DESKTOP_PORTABLE_ROOT must be an explicit absolute path" >&2; exit 2 ;;
esac
if [ -e "$proof_root" ] && [ ! -d "$proof_root" ]; then
  echo "NUCLEUS_DESKTOP_PORTABLE_ROOT must identify a directory" >&2
  exit 2
fi

fixture_root=${NUCLEUS_DESKTOP_PROOF_FIXTURE_ROOT-}
case "$fixture_root" in
  /*) ;;
  *) echo "NUCLEUS_DESKTOP_PROOF_FIXTURE_ROOT must be an explicit absolute path" >&2; exit 2 ;;
esac
if [ ! -d "$fixture_root" ] || [ ! -d "$fixture_root/.git" ]; then
  echo "NUCLEUS_DESKTOP_PROOF_FIXTURE_ROOT must identify an existing Git repository" >&2
  exit 2
fi

proof_timeout=${NUCLEUS_AGENT_CHAT_TURN_TIMEOUT_MS-180000}
case "$proof_timeout" in
  ""|*[!0-9]*) echo "NUCLEUS_AGENT_CHAT_TURN_TIMEOUT_MS must be an integer" >&2; exit 2 ;;
esac
if [ "$proof_timeout" -lt 1 ] || [ "$proof_timeout" -gt 180000 ]; then
  echo "NUCLEUS_AGENT_CHAT_TURN_TIMEOUT_MS must be between 1 and 180000" >&2
  exit 2
fi

case "${1-}" in
  launch)
    cd apps/desktop
    exec bun run tauri:dev
    ;;
  evidence)
    exec cargo run --quiet -p nucleus-desktop --bin native-proof-evidence -- "$proof_root"
    ;;
  *)
    echo "native proof action must be launch or evidence" >&2
    exit 2
    ;;
esac
