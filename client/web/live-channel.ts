/** One server-sent event frame: the event name and the first data line, as the service writes them. */
export type LiveFrame = { event: string | null; data: string | null };

/**
 * Split the complete frames off the read buffer. The tail is the next read's
 * prefix, so a frame split across two reads is decoded once, whole.
 */
export function readLiveFrames(pending: string): {
  frames: LiveFrame[];
  rest: string;
} {
  const text = pending.replace(/\r\n/g, "\n");
  const frames: LiveFrame[] = [];
  let rest = text;
  let end: number;
  while ((end = rest.indexOf("\n\n")) >= 0) {
    const frame = rest.slice(0, end);
    rest = rest.slice(end + 2);
    frames.push({
      event: /^event: (.+)$/m.exec(frame)?.[1] ?? null,
      data: /^data: (.+)$/m.exec(frame)?.[1] ?? null,
    });
  }
  return { frames, rest };
}
