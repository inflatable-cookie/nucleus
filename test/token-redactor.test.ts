import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenRedactor, redactTokenBuffer } from "../core/machine/token-redactor";

test("token redaction keeps split, adjacent and repeated tokens out at every boundary", () => {
  const secret = "token-ä-012345";
  const source = Buffer.from(`before ${secret}${secret} after ${secret}`);
  const expected = "before [REDACTED][REDACTED] after [REDACTED]";
  for (let split = 0; split <= source.length; split++) {
    const chunks: Buffer[] = [];
    const writer = tokenRedactor(secret, bytes => chunks.push(bytes));
    writer.write(source.subarray(0, split)); writer.write(source.subarray(split)); writer.flush();
    assert.equal(Buffer.concat(chunks).toString(), expected, `split ${split}`);
  }
  assert.equal(redactTokenBuffer(source, secret).toString(), expected);
});

test("failure collectors can redact a secret prefix at end of output", () => {
  const chunks: Buffer[] = [];
  const writer = tokenRedactor("private-token", chunk => chunks.push(chunk), true);
  writer.write(Buffer.from("failure private-to")); writer.flush();
  assert.equal(Buffer.concat(chunks).toString(), "failure [REDACTED]");
});
