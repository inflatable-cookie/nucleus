import { test } from "node:test";
import assert from "node:assert/strict";
import { controlManifestSchema, hookProgramPinSchema } from "../shared/hooks";

const manifest = (program: unknown) => ({ schema: "paseo.queue.control.v2", hooks: [{ id: "policy", events: ["task.pre_dispatch"], mode: "read_only", delivery: "required", program, timeoutMs: 1000, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null }] });
test("tool names are plain and legacy names normalize without an approval registry", () => {
  const parsed = controlManifestSchema.parse(manifest({ kind: "trusted_runner", runner: "effigy", argv: [] }));
  assert.equal(parsed.schema, "paseo.queue.control.v2");
  if (parsed.schema !== "paseo.queue.control.v2") throw new Error("wrong schema");
  assert.deepEqual(parsed.hooks[0].program, { kind: "tool", name: "effigy", argv: [] });
  for (const name of ["../effigy", "$(effigy)", "a/b", "a b"]) assert.equal(controlManifestSchema.safeParse(manifest({ kind: "tool", name, argv: [] })).success, false);
});

test("historical approval pins remain readable", () => {
  const pin = { kind: "trusted_runner", runner: "effigy", hostId: "host", revision: 1, digest: `sha256:${"a".repeat(64)}`, size: 1, mode: 493, os: "darwin", architecture: "arm64", versionLabel: null, artifact: "a".repeat(64), argv: [] };
  assert.deepEqual(hookProgramPinSchema.parse(pin), pin);
  const unavailable = { kind: "unavailable_trusted_runner", runner: "effigy", argv: [], error: "unavailable" };
  assert.deepEqual(hookProgramPinSchema.parse(unavailable), unavailable);
});
