import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { readLiveFrames } from "../client/web/live-channel";
import { createRustInvalidator, rustInvalidationFromFrame } from "../client/web/rust-board";
import { waitFor } from "./support/budgets";

test("the reader splits native frames and keeps a partial one for the next read", () => {
  const split = readLiveFrames(
    'retry: 3000\n\n: keepalive\n\nevent: refresh\ndata: {}\n\nevent: invalidate\ndata: {"taskId":"fixture","vers',
  );
  assert.deepEqual(split.frames, [
    { event: null, data: null },
    { event: null, data: null },
    { event: "refresh", data: "{}" },
  ]);
  assert.equal(split.rest, 'event: invalidate\ndata: {"taskId":"fixture","vers');

  const completed = readLiveFrames(split.rest + 'ion":7}\n\n');
  assert.deepEqual(completed, {
    frames: [{ event: "invalidate", data: '{"taskId":"fixture","version":7}' }],
    rest: "",
  });
});

test("carriage returns are normalised before a frame is split", () => {
  const read = readLiveFrames("event: settings\r\ndata: {}\r\n\r");
  assert.deepEqual(read.frames, []);
  assert.deepEqual(readLiveFrames(read.rest + "\n"), {
    frames: [{ event: "settings", data: "{}" }],
    rest: "",
  });
});

test("only valid native task notifications invalidate the projection", () => {
  const received: Array<[string | undefined, boolean | undefined]> = [];
  const invalidate = (id?: string, detailOnly?: boolean) => received.push([id, detailOnly]);
  const { frames } = readLiveFrames([
    ": keepalive",
    "retry: 3000",
    "event: future-event\ndata: {}",
    "event: invalidate\ndata: not json",
    'event: invalidate\ndata: {"taskId":"fixture","version":"wrong"}',
    'event: invalidate\ndata: {"taskId":"fixture","version":7,"detailOnly":true}',
    "event: refresh\ndata: {}",
  ].join("\n\n") + "\n\n");

  for (const frame of frames) rustInvalidationFromFrame(frame, invalidate);

  assert.deepEqual(received, [["fixture", true], [undefined, undefined]]);
});

for (const precedingRead of ["fulfills", "rejects"] as const) {
  test(`a native push queues one trailing read when its preceding read ${precedingRead}`, async () => {
    const client = new QueryClient();
    const queryKey = ["rust-board", "list"];
    const reads: AbortSignal[] = [];
    let settleFirst: () => void = () => {};
    const observer = new QueryObserver(client, {
      queryKey,
      retry: false,
      queryFn: ({ signal }) => {
        reads.push(signal);
        if (reads.length > 1) return Promise.resolve("fresh result");
        return new Promise<string>((resolve, reject) => {
          settleFirst = () => {
            if (precedingRead === "fulfills") resolve("superseded result");
            else reject(new Error("initial read failed"));
          };
        });
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      const invalidate = createRustInvalidator(client);
      const { frames } = readLiveFrames(
        'event: invalidate\ndata: {"taskId":"fixture","version":7}\n\n'.repeat(3),
      );
      for (const frame of frames) rustInvalidationFromFrame(frame, invalidate);

      assert.equal(reads.length, 1, "the first read stays in flight");
      assert.equal(reads[0]?.aborted, false);
      settleFirst();
      await waitFor(
        () => observer.getCurrentResult().data === "fresh result",
        undefined,
        "the trailing read updates the observed board",
      );
      assert.equal(reads.length, 2, "the three pushes were coalesced");
      assert.equal(reads[0]?.aborted, false);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
}
