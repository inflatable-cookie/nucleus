import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Decisions } from "../core/planning/decisions";
import { Store } from "../core/store/store";
import { WebBoard } from "../service/web/web-board";
import { configuredRustInbox } from "../service/web/rust-inbox";
import {
  RUST_INBOX_ACCEPT, RUST_INBOX_DECLINE, RUST_INBOX_PATH, type RustInboxRequest,
} from "../shared/rust-inbox";

test("the Rust bridge accepts one dedicated key and fences withdrawal before an ensure", async (context) => {
  const scratch = mkdtempSync(join(tmpdir(), "rust-inbox-"));
  const store = new Store(join(scratch, "queue.sqlite"));
  const project = { origin: "example/greeter", path: scratch };
  store.upsertProject({ key: "greeter", name: "Greeter", repositories: [project] });
  const decisions = new Decisions(store);
  const key = "a".repeat(64);
  const keyFile = join(scratch, "inbox.key");
  writeFileSync(keyFile, key + "\n", { mode: 0o600 });
  const bridge = configuredRustInbox({
    NUCLEUS_RUST_INBOX_ENGINE: "test-engine",
    NUCLEUS_RUST_INBOX_KEY_FILE: keyFile,
  }, async (input) => decisions.rustInbox(input));
  assert.ok(bridge);
  const refused = () => { throw new Error("The bridge must never enter general board RPC"); };
  const board = new WebBoard({
    host: { call: refused, board: refused, t3Theme: refused, unavailable: () => null, subscribe: () => () => {} },
    rustInbox: bridge,
    port: 0,
  });
  context.after(async () => {
    await board.close();
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const port = await board.listen();
  const input = {
    operation: "ensure", id: "rust-inbox:test-engine:greeter:1",
    repository: project.origin, reference: "greeter#1", head: "b".repeat(40),
  } satisfies RustInboxRequest;
  const post = (request: unknown, bearer: string, path = RUST_INBOX_PATH) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(request),
    });
  assert.equal((await post(input, "c".repeat(64))).status, 401);
  assert.equal((await post({ ...input, operation: "answer" }, key)).status, 400);
  assert.equal((await post({ method: "decision.answer", input: {} }, key, "/api/rpc")).status, 401);
  assert.equal(decisions.list({}).length, 0);
  assert.deepEqual(await (await post(input, key)).json(), { state: "pending" });
  assert.deepEqual(await (await post(input, key)).json(), { state: "pending" });
  assert.equal(decisions.list({}).length, 1);
  const answer = {
    id: input.id, version: 1, answer: RUST_INBOX_ACCEPT, relayed: false,
    answeredBy: "operator (t3code:fixture)", note: "Checked the merge.",
  };
  assert.throws(() => decisions.answer(answer), /pinned Inbox/);
  const accepted = decisions.answer(answer, { trustedT3: true });
  assert.equal(accepted.delivery, null);
  assert.deepEqual(await (await post(input, key)).json(), {
    state: "accepted", actor: answer.answeredBy, reason: answer.note,
  });

  const declined = { ...input, id: "rust-inbox:test-engine:greeter:2" };
  await post(declined, key);
  decisions.answer({ ...answer, id: declined.id, answer: RUST_INBOX_DECLINE }, { trustedT3: true });
  assert.deepEqual(await (await post(declined, key)).json(), { state: "declined" });
  const stale = { ...input, id: "rust-inbox:test-engine:greeter:3" };
  assert.deepEqual(await (await post({ ...stale, operation: "withdraw" }, key)).json(), { state: "withdrawn" });
  assert.deepEqual(await (await post(stale, key)).json(), { state: "withdrawn" });
  assert.deepEqual(decisions.list({ status: "open" }), []);
});
