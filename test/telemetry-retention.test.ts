import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { telemetryScreenWindows } from "../shared/telemetry";

test("the Telemetry screen offers 24h, 7d, 30d and 90d and retires All", () => {
  assert.deepEqual([...telemetryScreenWindows], ["24h", "7d", "30d", "90d"]);
  const ui = readFileSync(new URL("../client/settings-telemetry.tsx", import.meta.url), "utf8");
  assert.match(ui, /telemetryScreenWindows\.map\(value=>/);
  assert.doesNotMatch(ui, /"90d","all"/);
  assert.match(ui, /accessibilityLabel="Telemetry coverage"/);
});
