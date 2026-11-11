#!/usr/bin/env node
// Detached test entry: derive the private mount from the authenticated plan.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { assertCheckoutAvailable } from "../../core/workspaces/checkout-volume.ts";
import { runQaSupervisorMain } from "../../service/executor/project-qa-supervisor.ts";

const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const mount = dirname(dirname(dirname(dirname(plan.checkoutPath))));
const relativeToTemp = relative(realpathSync(tmpdir()), realpathSync(mount));
if (relativeToTemp.startsWith("..") || !relativeToTemp || join(mount, "queue", "project-qa") !== dirname(dirname(plan.checkoutPath)))
  throw new Error("fixture supervisor requires a private temporary mount");
await runQaSupervisorMain(process.argv.slice(2), target => assertCheckoutAvailable({
  mount, uuid: "fixture", target,
  observe: () => ({ MountPoint: mount, VolumeUUID: "fixture", Internal: false, Writable: true, WritableVolume: true }),
}));
