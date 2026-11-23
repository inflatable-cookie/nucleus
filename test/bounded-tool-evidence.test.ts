import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostProcessFact } from "../core/host/types";
import { workspaceToolProcessIssue } from "../core/recovery/stall";
import { bbProcessFixture } from "./support/bb-process-fixture";
import {
  loadedExecutablePaths,
  markTrustedCuaProcesses,
} from "../core/machine/host-process-listing";

test("the process reader checks the loaded image and its start identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bb-cua-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, "installed"),
    workspace = join(root, "workspace");
  mkdirSync(installed);
  mkdirSync(workspace);
  const trusted = join(installed, "cua-driver"),
    counterfeit = join(workspace, "cua-driver");
  writeFileSync(trusted, "");
  writeFileSync(counterfeit, "");
  const alias = join(root, "cua-driver");
  symlinkSync(trusted, alias);
  const fact = (pid: number, command: string): HostProcessFact => ({
    pid,
    ppid: 1,
    pgid: pid,
    uid: 1,
    startIdentity: `${pid}@fixture`,
    command,
    cwd: workspace,
  });
  const facts = [
    fact(1, `${alias} mcp`),
    fact(2, `${alias} mcp`),
    fact(3, `${alias} mcp`),
  ];
  await markTrustedCuaProcesses(facts, alias, {
    images: async () =>
      new Map([
        [1, trusted],
        [2, counterfeit],
        [3, trusted],
      ]),
    identity: async (pid) => ({
      kind: "identity",
      identity: pid === 3 ? "3@reused" : `${pid}@fixture`,
    }),
  });
  assert.equal(facts[0]!.trustedCuaExecutable, true);
  assert.equal(facts[1]!.trustedCuaExecutable, undefined);
  assert.equal(facts[2]!.trustedCuaExecutable, undefined);
  const runtime = await bbProcessFixture(workspace, "thread");
  const impostor = {
    ...runtime[3]!,
    pid: 300,
    command: `${alias} mcp`,
    trustedCuaExecutable: false,
  };
  await markTrustedCuaProcesses([impostor], alias, {
    images: async () => new Map([[300, counterfeit]]),
    identity: async () => ({
      kind: "identity",
      identity: impostor.startIdentity,
    }),
  });
  assert.match(
    workspaceToolProcessIssue([...runtime, impostor], workspace, ["run"], {
      bbThreads: ["thread"],
    })!,
    /process 300 remains/,
  );
});

test(
  "the host reads the running executable image",
  { skip: !["darwin", "linux"].includes(process.platform) },
  async () => {
    const image = (await loadedExecutablePaths([process.pid])).get(process.pid);
    assert.ok(image);
    assert.equal(realpathSync(image), realpathSync(process.execPath));
  },
);
