/** The plugin entry alone binds service process effects to the neutral bridge port. */
import { spawn } from "node:child_process";
import { writeOwnedJson } from "../../core/machine/owned-file.mjs";
import { processCpuMs } from "../../core/machine/process-tree-cpu";
import { MainChannel } from "./main-channel.mjs";
import { activateVersion, verifyVersion } from "./install.mjs";
import { pidAlive, removeServiceStartupFailure, writeServiceRoll, writeServiceStartupFailure } from "../transport/identity";
import { consumeServiceRollRequest } from "./roll-request";
import { clearMaintenance, clearMigration, clearStandbyReady, standbyIsReady, startupExtensionMs } from "./standby";
import type { BridgeProcessActions } from "../../shared/service/bridge-process";

export const bridgeProcessActions: BridgeProcessActions = {
  openMainChannel: sourcePath => MainChannel.open(sourcePath),
  verifyVersion: root => verifyVersion(root),
  activateVersion: root => activateVersion(root),
  processCpuMs: pid => processCpuMs(pid),
  spawn, pidAlive, writeOwnedJson, removeServiceStartupFailure, writeServiceRoll,
  writeServiceStartupFailure, consumeServiceRollRequest, clearMaintenance,
  clearMigration, clearStandbyReady, standbyIsReady, startupExtensionMs,
};
