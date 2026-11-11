/** A single byte-stream redactor for retained output and live projections. */
export function tokenRedactor(secret: string | (() => string | undefined) | undefined,
  publish: (bytes: Buffer) => void, redactPartialTail = false): { write(chunk: Buffer): void; flush(): void } {
  let pending: Buffer = Buffer.alloc(0);
  const push = (chunk: Buffer, final: boolean) => {
    const input = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    pending = Buffer.alloc(0);
    const value = typeof secret === "function" ? secret() : secret;
    if (!value) { publish(input); return; }
    const needle = Buffer.from(value);
    const safeEnd = final ? input.length : Math.max(0, input.length - needle.length + 1);
    let offset = 0;
    let flushEnd = safeEnd;
    for (let found = input.indexOf(needle); found >= 0 && found < safeEnd; found = input.indexOf(needle, offset)) {
      publish(input.subarray(offset, found));
      publish(Buffer.from("[REDACTED]"));
      offset = found + needle.length;
      flushEnd = Math.max(flushEnd, offset);
    }
    let tail = input.subarray(offset, flushEnd);
    if (final && redactPartialTail) {
      for (let size = Math.min(needle.length - 1, tail.length); size > 0; size--) {
        if (tail.subarray(-size).equals(needle.subarray(0, size))) {
          tail = Buffer.concat([tail.subarray(0, -size), Buffer.from("[REDACTED]")]);
          break;
        }
      }
    }
    publish(tail);
    if (!final) pending = input.subarray(flushEnd);
  };
  return { write: chunk => push(chunk, false), flush: () => push(Buffer.alloc(0), true) };
}

export function redactTokenBuffer(input: Buffer, secret: string | undefined): Buffer {
  if (!secret) return input;
  const chunks: Buffer[] = [];
  const writer = tokenRedactor(secret, chunk => chunks.push(chunk));
  writer.write(input); writer.flush();
  return Buffer.concat(chunks);
}
