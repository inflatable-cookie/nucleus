/**
 * Spec 065: what a launched ACP agent process reads before it speaks the protocol.
 *
 * A host registers the agent as a provider and starts it in a thread whose working
 * directory is the task's checkout. That is the only thing the agent needs to find
 * its session: Nucleus minted the binding under the data home, keyed by that
 * directory, and the binding names both the credential and the socket. Nothing is
 * read from the prompt, and nothing here is host-specific.
 *
 * Environment (all optional):
 * - `NUCLEUS_DATA_HOME`: the data home whose `acp/bindings/` holds the pointer.
 * - `NUCLEUS_ACP_SESSION`: an explicit binding path, for a host that can pass one.
 * - `NUCLEUS_ACP_IGNORE_PATTERN`: a host's waking-prompt rule when the binding has none.
 * - `NUCLEUS_ACP_HOLD_PATTERN`: a host's re-entry rule when the binding has none.
 */
import { isAbsolute, join } from "node:path";
import { compiledIdentity } from "../runtime.mjs";
import { dataHome } from "../data-home.mjs";
import { AcpAgent } from "./agent";
import { isLegacyT3Hold } from "./t3-hold";
import { acpBindingPathFor, readAcpBinding } from "./binding";
import { createAcpTransport } from "./transport";

export interface AcpEntryOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/**
 * Run the agent on a real process's stdio until its input closes. Returns the exit
 * code: 0 when the client closes the stream, 1 when the process cannot start at all
 * (an unusable data home or ignore rule). A missing binding is not a startup
 * failure: `session/new` answers it, so the client sees the reason.
 */
export async function runAcpAgentFromEnvironment(options: AcpEntryOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const stderr = options.stderr ?? process.stderr;
  const log = (line: string) => { stderr.write(`nucleus-acp: ${line}\n`); };
  let home: string;
  try { home = dataHome(env); }
  catch (error) { log(error instanceof Error ? error.message : String(error)); return 1; }
  const explicitIgnore = env.NUCLEUS_ACP_IGNORE_PATTERN?.trim();
  const ignore = compileIgnore(explicitIgnore ?? null);
  if (!ignore.ok) { log(`NUCLEUS_ACP_IGNORE_PATTERN is not a usable regular expression: ${explicitIgnore}`); return 1; }
  const explicitHold = env.NUCLEUS_ACP_HOLD_PATTERN?.trim();
  const hold = compileIgnore(explicitHold ?? null);
  if (!hold.ok) { log(`NUCLEUS_ACP_HOLD_PATTERN is not a usable regular expression: ${explicitHold}`); return 1; }
  /** One compile per pattern: every prompt of a session asks the same rule. */
  const hostRules = new Map<string, IgnoreCompilation>();
  const hostRuleFor = (pattern: string | null): IgnoreCompilation => {
    const key = pattern ?? "";
    const cached = hostRules.get(key);
    if (cached) return cached;
    const compiled = compileIgnore(pattern);
    hostRules.set(key, compiled);
    return compiled;
  };
  const agent = new AcpAgent({
    version: compiledIdentity?.revision?.slice(0, 12) ?? "dev",
    log,
    async resolve(directory) {
      const binding = readAcpBinding(acpBindingPathFor(absolutePath(directory, cwd), home, env.NUCLEUS_ACP_SESSION));
      return { binding, transport: createAcpTransport(binding) };
    },
    ignore(text, binding) {
      const hostRule = hostRuleFor(binding.ignorePattern ?? null);
      if (!hostRule.ok) { log(`the binding's ignorePattern is not a usable regular expression: ${binding.ignorePattern}`); return false; }
      return (ignore.rule?.(text) ?? false) || (hostRule.rule?.(text) ?? false);
    },
    hold(text, binding) {
      const hostRule = hostRuleFor(binding.holdPattern ?? null);
      if (!hostRule.ok) { log(`the binding's holdPattern is not a usable regular expression: ${binding.holdPattern}`); return false; }
      return isLegacyT3Hold(binding.holdPattern, text) || (hold.rule?.(text) ?? false) || (hostRule.rule?.(text) ?? false);
    },
  });
  await agent.run(options.stdin ?? process.stdin, options.stdout ?? process.stdout);
  return 0;
}

/** No pattern, one usable rule, or a source that cannot be compiled. */
type IgnoreCompilation = { ok: true; rule: ((text: string) => boolean) | null } | { ok: false };

function compileIgnore(pattern: string | null): IgnoreCompilation {
  if (pattern === null) return { ok: true, rule: null };
  try {
    const expression = new RegExp(pattern);
    return { ok: true, rule: text => { expression.lastIndex = 0; return expression.test(text); } };
  } catch { return { ok: false }; }
}

/** The checkout's absolute path; the binding's own key canonicalises it. */
const absolutePath = (directory: string, cwd: string): string => isAbsolute(directory) ? directory : join(cwd, directory);
