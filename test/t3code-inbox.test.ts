import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import type { AcpSessionSurface } from "../shared/acp/surface";
import { t3Fake, syntheticRuntimeRequest } from "./support/t3code-fake";

test("one host inbox is launched once and pinned outside task retention", async t => {
  const root = mkdtempSync(join(tmpdir(), "t3-inbox-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inboxDir = join(root, "inbox"); mkdirSync(inboxDir);
  const fake = await t3Fake(t, root);
  fake.controls.providers = [{ instanceId: "nucleus", displayName: "Nucleus", driver: "acpRegistry", enabled: true, status: "ready", models: [{ slug: "nucleus", name: "Nucleus" }] }];
  let mints = 0;
  const acp: AcpSessionSurface = {
    bind: () => { throw Error("no task binding"); },
    bindInbox: ({ hostId }) => { mints++; return { sessionId: "synthetic-session", hostId, directory: inboxDir, bindingPath: join(root, "binding") }; },
    decisionSettlement: id => id.startsWith("1111") ? { state: "answered", answer: "Yes" } : { state: "cancelled" },
    turn: async () => { throw Error("not called"); }, message: async () => { throw Error("not called"); }, release: () => {},
  };
  const host = new T3CodeHost({ endpoint: fake.endpoint, bearer: "synthetic-bearer", statePath: join(root, "state.json"), probeThreadId: "synthetic-probe", acp: () => acp });
  t.after(() => host.close());
  await host.connect();
  await host.reconcileThreadTitles([]);
  await host.reconcileThreadTitles([]);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  assert.equal(mints, 1);
  assert.equal(fake.commands.filter(command => command.method === "orchestration.launchThread" && command.threadId === inbox.threadId).length, 1);
  assert.equal(fake.commands.filter(command => command.type === "thread.pin" && command.threadId === inbox.threadId).length, 1);
  assert.ok(fake.threads.get(inbox.threadId)?.thread.pinnedAt);
  assert.equal(host.reads.workspaceFor(fake.threads.get(inbox.threadId)!.thread), inbox.workspaceId);
  assert.equal(Object.values(host.state.read().agents).some(agent => agent.id === inbox.threadId), false);
  const projection = fake.threads.get(inbox.threadId)!;
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  projection.runtimeRequests = ids.map((id, index) => syntheticRuntimeRequest({ id: `request-${index}`, nodeId: `node-${index}` }));
  projection.turnItems = ids.map((id, index) => ({ id: `item-${index}`, nodeId: `node-${index}`, ordinal: index, type: "user_input_request", requestId: `request-${index}`,
    questions: [{ id: `nucleus_${id}_1`, header: "Choice", question: "Choose?", options: [{ label: "Yes" }] }] }));
  await host.decisionCards.reconcile(inbox.threadId, inbox.workspaceId);
  const responses = fake.commands.filter(command => command.type === "runtime-request.respond");
  assert.deepEqual(responses[0].answers, { [`nucleus_${ids[0]}_1`]: ["Yes"] });
  assert.equal(responses[1].decision, "cancel");
  assert.equal(projection.runtimeRequests[1].status, "cancelled");
});
