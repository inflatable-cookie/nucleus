import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintAcpInbox, verifyAcpInbox } from "../core/acp/inbox-binding";
import { acpInboxBindingSchema } from "../shared/acp/inbox-binding";

test("inbox credentials are scoped to one host and rotation revokes the prior session", (t) => {
  const root = mkdtempSync(join(tmpdir(), "acp-inbox-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = mintAcpInbox({ dataHome: root, socketPath: join(root, "socket"), hostId: "t3code:host" });
  const binding = acpInboxBindingSchema.parse(JSON.parse(readFileSync(first.bindingPath, "utf8")));
  assert.equal(statSync(first.bindingPath).mode & 0o777, 0o600);
  assert.equal(verifyAcpInbox({ dataHome: root, hostId: binding.hostId, sessionId: binding.sessionId }, binding.token).kind, "inbox");
  assert.throws(() => verifyAcpInbox({ dataHome: root, hostId: "t3code:other", sessionId: binding.sessionId }, binding.token));
  const second = mintAcpInbox({ dataHome: root, socketPath: join(root, "socket"), hostId: binding.hostId });
  assert.notEqual(second.sessionId, first.sessionId);
  assert.throws(() => verifyAcpInbox({ dataHome: root, hostId: binding.hostId, sessionId: binding.sessionId }, binding.token));
  const replacement = acpInboxBindingSchema.parse(JSON.parse(readFileSync(second.bindingPath, "utf8")));
  assert.equal(verifyAcpInbox({ dataHome: root, hostId: replacement.hostId, sessionId: replacement.sessionId }, replacement.token).sessionId, second.sessionId);
});
