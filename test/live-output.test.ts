/**
 * The per-run live log the operators' tab follows (task 530). It exists so a
 * running test or QA run has something to watch; it is a window, never the
 * record. These tests pin the three properties that matter: chunks land in the
 * order they happened, a run's token never reaches the file even when a chunk
 * boundary splits it, and a very long run keeps writing without growing the file
 * without bound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_OUTPUT_BYTES, openLiveOutputLog } from "../core/machine/live-output";

const scratch = (t: any): string => {
  const root = mkdtempSync(join(tmpdir(), "queue-live-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test("the live log keeps every chunk in arrival order and closes cleanly", (t) => {
  const root = scratch(t);
  const path = join(root, "run", "live.log");
  const log = openLiveOutputLog(path);
  assert.ok(log, "an owner-writable path opens");
  log.write(Buffer.from("first\n"));
  log.write(Buffer.from("second\n"));
  log.close();
  assert.equal(readFileSync(path, "utf8"), "first\nsecond\n");
  // A log that cannot be created is absent, never a fabricated empty file.
  writeFileSync(join(root, "blocked"), "");
  assert.equal(openLiveOutputLog(join(root, "blocked", "live.log")), null);
});

test("a run's token never reaches the live log, even split across two chunks", (t) => {
  const path = join(scratch(t), "live.log");
  const secret = "host-run-token-9f2c";
  const log = openLiveOutputLog(path, secret)!;
  log.write(Buffer.from(`before ${secret.slice(0, 8)}`));
  log.write(Buffer.from(`${secret.slice(8)} after`));
  log.close();
  const written = readFileSync(path, "utf8");
  assert.equal(written, "before [REDACTED] after");
  assert.ok(!written.includes(secret));
});

test("a token issued after the log was opened is still kept out", (t) => {
  const path = join(scratch(t), "live.log");
  let token: string | undefined;
  const log = openLiveOutputLog(path, () => token)!;
  log.write(Buffer.from("before the token exists\n"));
  token = "issued-token-4c1d";
  log.write(Buffer.from("after issued-token-4c1d\n"));
  log.close();
  assert.equal(
    readFileSync(path, "utf8"),
    "before the token exists\nafter [REDACTED]\n",
  );
});

test("a long run keeps only the most recent live bytes", (t) => {
  const path = join(scratch(t), "live.log");
  const log = openLiveOutputLog(path)!;
  const chunk = Buffer.from("x".repeat(64 * 1024));
  const rounds = Math.ceil((LIVE_OUTPUT_BYTES * 2) / chunk.length);
  for (let index = 0; index < rounds; index++) log.write(chunk);
  log.write(Buffer.from("\nlast line\n"));
  log.close();
  const size = statSync(path).size;
  assert.ok(
    size <= LIVE_OUTPUT_BYTES + 1024,
    `the live log stays bounded (${size} bytes)`,
  );
  assert.ok(
    readFileSync(path, "utf8").endsWith("last line\n"),
    "the newest output survives the cap",
  );
});
