#!/usr/bin/env node
/**
 * One live-run terminal tab (task 530).
 *
 * The service opens this process in the owning workspace's terminal tab, named
 * for the run. It reads one pointer file the service keeps for that workspace
 * and selector, follows the run's live log as it grows, prints the service's
 * final status line when the run settles, and then waits in the same tab for the
 * next run. Reusing the tab this way means Queue never leaves a stream of dead
 * tabs behind, and a service restart changes nothing for a tab that is already
 * following: only the pointer file it polls moves.
 *
 * The pointer is written by `core/telemetry/live-run-presence.ts`; this script only
 * renders it. It owns no Queue state, never writes anything and never exits on
 * its own, so nothing here can affect the run it observes.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

const POLL_MS = Number(process.env.QUEUE_RUN_TERMINAL_POLL_MS ?? 400);
const PULL_BYTES = 64 * 1024;
const pointerPath = process.argv[2];

if (!pointerPath) {
  process.stderr.write("usage: queue-run-terminal.mjs <pointer.json>\n");
  process.exit(64);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = text => { if (text) { try { process.stdout.write(text); } catch { /* the tab is gone */ } } };

function readPointer() {
  try {
    const parsed = JSON.parse(readFileSync(pointerPath, "utf8"));
    return parsed && parsed.format === "queue.run-terminal" && parsed.version === 1 ? parsed : null;
  } catch { return null; }
}

/** Append everything the followed log gained since the last poll. */
function drain(path, session) {
  let fd;
  try { fd = openSync(path, "r"); } catch { return; }
  try {
    const size = fstatSync(fd).size;
    let offset = session.offsets.get(path) ?? 0;
    // A live log that restarted (its byte cap) is read again from its beginning.
    if (size < offset) offset = 0;
    const buffer = Buffer.alloc(PULL_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      if (read <= 0) break;
      offset += read;
      emit(buffer.subarray(0, read).toString("utf8"));
    }
    session.offsets.set(path, offset);
  } catch { /* an unreadable log is retried on the next poll */ }
  finally { try { closeSync(fd); } catch { /* already gone */ } }
}

/** Follow the pointer's run until it settles, then wait for the next one. */
async function main() {
  let session = null;
  for (;;) {
    const pointer = readPointer();
    if (pointer && pointer.runId) {
      // A new run (or the same run relaunched) starts its own session in this tab.
      if (!session || session.id !== pointer.sessionId) {
        session = { id: pointer.sessionId, paths: Array.isArray(pointer.outputs) ? pointer.outputs : [], offsets: new Map(), settled: false };
        emit(`\n[queue] ${pointer.tabName} · following ${pointer.runId}\n`);
      }
      for (const path of session.paths) drain(path, session);
      if (pointer.settledLine && !session.settled) {
        for (const path of session.paths) drain(path, session);
        session.settled = true;
        emit(`\n[queue] ${pointer.settledLine}\n[queue] ${pointer.tabName} is idle; this tab follows the next run in this workspace\n`);
      }
    }
    await sleep(POLL_MS);
  }
}

await main();
