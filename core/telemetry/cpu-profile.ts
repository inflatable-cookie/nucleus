import { Session } from "node:inspector/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Capture a V8 CPU profile of the calling thread for a bounded time and write it
 * as a `.cpuprofile` file. In the standalone service the caller is the runtime
 * executor worker, so this sees the work behind event-loop stalls that a native
 * `sample` cannot name under Electron (2026-10-03: live stalls up to 12 s that a
 * store-backup replay did not reproduce).
 */
export async function captureCpuProfile(directory: string, seconds: number): Promise<{ path: string; seconds: number; nodes: number }> {
  const bounded = Math.min(60, Math.max(1, Math.round(Number.isFinite(seconds) ? seconds : 10)));
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 1000 });
    await session.post("Profiler.start");
    await new Promise(resolve => setTimeout(resolve, bounded * 1000));
    const { profile } = await session.post("Profiler.stop") as { profile: { nodes: unknown[] } };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `runtime-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`);
    writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
    return { path, seconds: bounded, nodes: profile.nodes.length };
  } finally {
    session.disconnect();
  }
}
