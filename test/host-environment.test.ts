/** The stopped service's remaining host boundaries and publication scanner. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hostEnvironment, hostHome } from "../service/host-environment.mjs";
import { hostEnvironmentNames } from "../scripts/check-host-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

function scratchRoot(prefix: string): string {
  const scratch = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  if (!scratch) throw new Error("the run scratch volume is required");
  return realpathSync(mkdtempSync(join(realpathSync(scratch), prefix)));
}

test("the composition owner maps a private host home into the host's own environment", () => {
  const home = join(scratchRoot("host-env-"), "host-home");
  // The generic composition names the host's own variable; nothing above it does.
  assert.deepEqual(hostEnvironment(home), { PASEO_HOME: home });
  // With no override, the composition owner resolves the host's own default home.
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    assert.equal(hostHome(), home);
    assert.deepEqual(hostEnvironment(), { PASEO_HOME: home });
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
  }
});

test("generic TypeScript service entries leave host names in composition", () => {
  const neutral = [
    "service/runtime-owner.ts",
  ];
  for (const path of neutral) {
    assert.deepEqual(
      hostEnvironmentNames(path, read(path)),
      [],
      `${path} must not name a host environment variable`,
    );
  }
});
