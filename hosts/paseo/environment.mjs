import { homedir } from 'node:os';
import { join } from 'node:path';

/** Host-owned configuration, independent of the Nucleus data home. */
export function paseoHomeOverride(env = process.env) { return env.PASEO_HOME || undefined; }
export function paseoHome(env = process.env) { return paseoHomeOverride(env) || join(env.HOME || homedir(), '.paseo'); }
/** Isolated service probes still configure the host through its own vocabulary. */
export function paseoHomeEnvironment(home) { return { PASEO_HOME: home }; }
