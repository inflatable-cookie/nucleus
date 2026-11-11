import { serviceInfoPath, SERVICE_ROLL_FILE, SERVICE_STARTUP_FAILURE_FILE, SERVICE_EXECUTOR_FAULT_FILE, serviceStartupFailureSchema, serviceExecutorFaultSchema, type ServiceInfo, type ServiceStartupFailure, type ServiceExecutorFault } from "../../shared/service/discovery";
/**
 * Local service identity and owner-only bootstrap files (Contract 007).
 *
 * The service owns its socket and credential under the existing Queue data
 * directory. All files are owner-only; a credential leak never crosses a user
 * boundary because the socket itself is owner-only too.
 */
import { writeOwnedJson } from "../../core/machine/owned-file.mjs";
export { pidAlive } from "../../core/machine/pid";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { serviceRollSchema, type ServiceRoll } from "../../shared/service-roll";

export { onLoginSessionFault, notifyLoginSessionFault } from "../../shared/session-fault";

/** Publish the owner-only identity file atomically so a bridge never reads a half-written credential. */
export function writeServiceInfo(dataDir: string, info: ServiceInfo) {
  writeOwnedJson(serviceInfoPath(dataDir), info);
}

export function writeServiceRoll(dataDir: string, roll: ServiceRoll | z.input<typeof serviceRollSchema>) {
  writeOwnedJson(join(dataDir, SERVICE_ROLL_FILE), serviceRollSchema.parse(roll));
}

/** Persist sanitized startup evidence atomically with owner-only permissions. */
export function writeServiceStartupFailure(dataDir: string, failure: ServiceStartupFailure) {
  writeOwnedJson(join(dataDir, SERVICE_STARTUP_FAILURE_FILE), serviceStartupFailureSchema.parse(failure));
}

export function removeServiceStartupFailure(dataDir: string) {
  rmSync(join(dataDir, SERVICE_STARTUP_FAILURE_FILE), { force: true });
}

/** Persist the executor death atomically with owner-only permissions; the caller decides what a failed write means. */
export function writeServiceExecutorFault(dataDir: string, fault: ServiceExecutorFault) {
  writeOwnedJson(join(dataDir, SERVICE_EXECUTOR_FAULT_FILE), serviceExecutorFaultSchema.parse(fault));
}

export function removeServiceInfo(dataDir: string) { rmSync(serviceInfoPath(dataDir), { force: true }); }

export function newCredential() { return randomBytes(32).toString("hex"); }

export * from "../../shared/service/discovery";
