import { test } from "node:test";
import assert from "node:assert/strict";
import { PaseoAdapter } from "../service/paseo-composition";
import { ArchiveNotDeliveredError } from "../core/workspaces/archive-delivery";

test("a failed pre-archive refresh proves no archive request was sent", async () => {
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", "unused", "unused");
  let archives = 0;
  (adapter as any).api = {
    agents: {
      ref: () => ({
        refresh: async () => {
          throw Error("Transport not connected");
        },
        archive: async () => {
          archives++;
        },
      }),
    },
  };
  await assert.rejects(
    adapter.archiveAgent("worker"),
    ArchiveNotDeliveredError,
  );
  assert.equal(archives, 0);
});
