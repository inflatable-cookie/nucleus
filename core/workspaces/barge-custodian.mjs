import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lease" || arg === "--token" || arg === "--ready" || arg === "--stop") {
      out[arg.slice(2)] = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.lease || !args.token || !args.ready || !args.stop) {
  process.stderr.write("barge-custodian: --lease, --token, --ready, and --stop are required\n");
  process.exit(2);
}

mkdirSync(dirname(args.ready), { recursive: true });
mkdirSync(dirname(args.stop), { recursive: true });

let exiting = false;
function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  clearInterval(timer);
  process.exit(code);
}

process.on("SIGHUP", () => {
  // Ignore SIGHUP so detached custody survives service rolls and terminal closes.
});
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

const tmpReady = `${args.ready}.tmp-${process.pid}`;
writeFileSync(
  tmpReady,
  JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    leaseId: args.lease,
    token: args.token,
    startedAt: new Date().toISOString(),
  }),
);
renameSync(tmpReady, args.ready);

const timer = setInterval(() => {
  if (existsSync(args.stop)) shutdown(0);
}, 150);

if (existsSync(args.stop)) shutdown(0);
