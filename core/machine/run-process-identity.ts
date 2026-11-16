import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import { processStartIdentityLiveness } from "./process-identity-search";

const execFileAsync = promisify(execFile);
const KEYS = ["NUCLEUS_TICKET", "NUCLEUS_CONTINUATION_TICKET", "TMPDIR", "TMP", "TEMP"] as const;
export type RunProcessEnvironment = Partial<Record<typeof KEYS[number], string>>;

/** Read only run ownership fields; never retain or log a process's full environment. Null is unknown. */
export async function runProcessEnvironments(pids: readonly number[]): Promise<Map<number, RunProcessEnvironment | null>> {
  const result = new Map<number, RunProcessEnvironment | null>();
  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        result.set(pid, Object.fromEntries(entries.flatMap(entry => {
          const at = entry.indexOf("=");
          const key = entry.slice(0, at);
          return KEYS.includes(key as typeof KEYS[number]) ? [[key, entry.slice(at + 1)]] : [];
        })));
      } catch { result.set(pid, null); }
    }
  } else if (process.platform === "darwin") {
    for (let offset = 0; offset < pids.length; offset += 64) {
      const chunk = pids.slice(offset, offset + 64);
      for (const pid of chunk) result.set(pid, null);
      try {
        const { stdout } = await execFileAsync("ps", ["-E", "-ww", "-p", chunk.join(","), "-o", "pid=,command="],
          { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
        for (const line of stdout.split("\n")) {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!match) continue;
          const environment: RunProcessEnvironment = {};
          for (const key of KEYS) {
            const value = new RegExp(`(?:^| )${key}=(.*?)(?= [A-Za-z_][A-Za-z_0-9]*=|$)`).exec(match[2])?.[1];
            if (value !== undefined) environment[key] = value;
          }
          result.set(Number(match[1]), environment);
        }
      } catch { /* The candidates in this chunk remain unknown. */ }
    }
  }
  return result;
}

/** Zombies have stopped; only their parent can reap them. */
export function runProcessLiveness(pid: number, identity: string): ReturnType<typeof processStartIdentityLiveness> {
  const live = processStartIdentityLiveness(pid, identity);
  if (live !== "alive" || process.platform !== "linux") return live;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return "dead";
  } catch { /* The identity reader remains authoritative for an unreadable process. */ }
  return live;
}
