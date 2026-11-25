import { test } from "node:test";
import assert from "node:assert/strict";
import { RPC_CATALOGUE } from "../shared/rpc-catalogue";
import { SETTINGS_WRITE_METHODS } from "../shared/web-surface";

test("every Settings write named by the web surface is a mutating catalogue method", () => {
  const byName = new Map(RPC_CATALOGUE.map((entry) => [entry.name, entry]));
  for (const name of SETTINGS_WRITE_METHODS) {
    const entry = byName.get(name);
    assert.ok(
      entry,
      `${name} must be a catalogue method, or the marker guards nothing`,
    );
    assert.equal(entry.mutating, true, `${name} changes state`);
  }
});
