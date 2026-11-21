/**
 * nucleus#1460's private proof for the prepared parent. The installed T3 nightly's own
 * server entry runs in this run's scratch with its own base directory, home and ports, and
 * the Nucleus service runs in-process over a private data home, as the held-turn proof does.
 * Nothing reads or writes a live T3 home, session or desktop data directory.
 *
 * The proof drives the real T3Code adapter against that isolated server. It runs once with
 * this checkout's code and once with the planning base's code (a scratch copy of that tree).
 * A small WebSocket relay sits between the adapter and the server. It only rewrites or drops
 * the frames a case names; every other frame passes through unchanged. It counts each request
 * the adapter sends, so a resend is measured, not inferred.
 *
 * Cases:
 * 0. the reported wire shape: an absent thread's read on the installed nightly;
 * 1. ordinary worker create over a prepared, unsent binding (sent once, never resent);
 * 2. owner restart precheck over a prepared binding (sends nothing, then launches once);
 * 3. a live parent whose narrow read is unreadable (waits, no second launch);
 * 4. inventory unavailable: the archived snapshot read answers with the generic incomplete read
 *    (injected at the relay; the rest of the wire is the nightly's own) (waits, no launch);
 * 5. lost send receipt, applied (adopted, one launch) and unapplied (never resent);
 * 6. first dispatch with no stored binding (launches in the same create).
 *
 * Run through `effigy proof:t3code:prepared-parent -- --label <fixed|pre-fix>`. Evidence is
 * compact JSON per case, written under the run root with the root named as a placeholder.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { T3CodeHost } from "../../hosts/t3code/adapter";
import { T3RpcClient } from "../../hosts/t3code/rpc";
import { HOLD_MARKER, PARENT_MODEL, PARENT_PROVIDER, parentPromptRules } from "../../hosts/t3code/nesting";
import { identity } from "../../hosts/t3code/intents";
import { canonical } from "../../hosts/t3code/state";
import { storedT3Labels } from "../../test/support/t3code-labels";
import { submissionSchema, type Profile, type Task } from "../../shared/contracts";
import type { HostAgentSpec } from "../../shared/host";
import { QueueService } from "../../service/transport/server";
import { AcpSessions } from "../../core/acp/sessions";
import { Store } from "../../core/store/store";
import type { Engine } from "../../core/engine";
import { extractArchive, freePort, run, scratchRoot, until } from "./t3code-private-kit";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const asarPath = resolve(process.env.NUCLEUS_T3_PROOF_ASAR ?? "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar");
/** The installed nightly line is recorded from its own metadata, never pinned here. */
const NIGHTLY = /^0\.1\.\d+-nightly\.\d+\.\d+$/;
const GENERIC_ABSENT = "OrchestrationV2GetThreadProjectionError";

type Frame = { fin: boolean; rsv1: boolean; opcode: number; raw: Buffer; payload: Buffer; size: number };
type Json = Record<string, unknown>;

/** One masked (client) or unmasked (server) WebSocket frame at the head of `buf`, if whole. */
function takeFrame(buf: Buffer): Frame | null {
  if (buf.length < 2) return null;
  const fin = (buf[0]! & 0x80) !== 0;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let length = buf[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) return null;
    length = buf.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buf.length < 10) return null;
    length = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let mask: Buffer | null = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + length) return null;
  const raw = Buffer.from(buf.subarray(0, offset + length));
  const payload = Buffer.from(buf.subarray(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
  return { fin, rsv1: (buf[0]! & 0x40) !== 0, opcode, raw, payload, size: offset + length };
}

/** A server-to-client text frame, unmasked, as the server itself writes one. */
function textFrame(text: string): Buffer {
  const body = Buffer.from(text);
  let head: Buffer;
  if (body.length < 126) head = Buffer.from([0x81, body.length]);
  else if (body.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([head, body]);
}

function parseText(frame: Frame): Json | null {
  if (frame.opcode !== 1) return null;
  try {
    const value = JSON.parse(frame.payload.toString("utf8")) as unknown;
    return value && typeof value === "object" ? (value as Json) : null;
  } catch {
    return null;
  }
}

type Rule = { tag: string; threadId?: string };
type Sent = { tag: string; threadId: string | null; outcome: string };

/**
 * A relay in front of the isolated server. Plain HTTP connections pass through raw; a
 * WebSocket upgrade is parsed, and only the frames a rule names are changed.
 */
class Relay {
  readonly sent: Sent[] = [];
  /** Raw server failure frames as the server wrote them (first two), for the evidence. */
  dropRequest: Rule[] = [];
  dropReply: Rule[] = [];
  replaceReply: Array<Rule & { error: string }> = [];
  private server: Server | null = null;
  port = 0;

  constructor(private readonly targetPort: number) {}

  async start(): Promise<void> {
    this.port = await freePort();
    this.server = createServer((client) => this.bridge(client));
    await new Promise<void>((done, fail) => {
      this.server!.once("error", fail);
      this.server!.listen(this.port, "127.0.0.1", () => done());
    });
  }

  stop(): void {
    this.server?.close();
  }

  count(tag: string, threadId?: string): number {
    return this.sent.filter((entry) => entry.tag === tag && (threadId === undefined || entry.threadId === threadId)).length;
  }

  private bridge(client: Socket): void {
    const upstream = connect(this.targetPort, "127.0.0.1");
    let clientBuf = Buffer.alloc(0);
    let serverBuf = Buffer.alloc(0);
    let clientHeaderDone = false;
    let serverHeaderDone = false;
    /** Plain HTTP connections pass through raw; only a WebSocket upgrade is parsed. */
    let mode: "undecided" | "raw" | "ws" = "undecided";
    const pending = new Map<string, { entry: Sent; withheld: boolean; replace: { error: string } | null }>();
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());

    client.on("data", (chunk: Buffer) => {
      if (mode === "raw") {
        upstream.write(chunk);
        return;
      }
      clientBuf = Buffer.concat([clientBuf, chunk]);
      if (!clientHeaderDone) {
        const end = clientBuf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = clientBuf.subarray(0, end + 4).toString("latin1");
        if (!/^upgrade:\s*websocket/im.test(head)) {
          mode = "raw";
          upstream.write(clientBuf);
          clientBuf = Buffer.alloc(0);
          return;
        }
        mode = "ws";
        // The relay reads plain frames: the upgrade stops offering permessage-deflate, so the
        // server answers uncompressed. Every other header passes through unchanged.
        upstream.write(Buffer.from(head.replace(/^sec-websocket-extensions:[^\r\n]*\r\n/gim, ""), "latin1"));
        clientBuf = clientBuf.subarray(end + 4);
        clientHeaderDone = true;
      }
      for (let frame = takeFrame(clientBuf); frame; frame = takeFrame(clientBuf)) {
        clientBuf = clientBuf.subarray(frame.size);
        const json = parseText(frame);
        if (json?._tag === "Request" && typeof json.tag === "string") {
          const payload = (json.payload ?? {}) as Json;
          const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
          const matches = (rule: Rule) => rule.tag === json.tag && (rule.threadId === undefined || rule.threadId === threadId);
          if (this.dropRequest.some(matches)) {
            this.sent.push({ tag: json.tag, threadId, outcome: "dropped-before-send" });
            closeBoth();
            return;
          }
          const withheld = this.dropReply.some(matches);
          const replace = this.replaceReply.find(matches) ?? null;
          const entry: Sent = { tag: json.tag, threadId, outcome: withheld ? "reply-withheld" : replace ? "reply-replaced" : "forwarded" };
          this.sent.push(entry);
          pending.set(String(json.id), { entry, withheld, replace });
          if (replace) {
            // The stream's own frames are dropped; the failure is answered at once, because the
            // server waits for the client's acknowledgement before it ends a stream.
            client.write(textFrame(JSON.stringify({ _tag: "Exit", requestId: String(json.id), exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: replace.error } }] } })));
          }
        }
        upstream.write(frame.raw);
      }
    });

    upstream.on("data", (chunk: Buffer) => {
      if (mode !== "ws") {
        client.write(chunk);
        return;
      }
      serverBuf = Buffer.concat([serverBuf, chunk]);
      if (!serverHeaderDone) {
        const end = serverBuf.indexOf("\r\n\r\n");
        if (end < 0) return;
        client.write(serverBuf.subarray(0, end + 4));
        serverBuf = serverBuf.subarray(end + 4);
        serverHeaderDone = true;
      }
      for (let frame = takeFrame(serverBuf); frame; frame = takeFrame(serverBuf)) {
        serverBuf = serverBuf.subarray(frame.size);
        // The server may batch frames: a text message is one frame or an array of frames.
        let decoded: unknown = null;
        if (frame.opcode === 1) {
          try {
            // permessage-deflate: a compressed message ends with the flushed empty block.
            const bytes = frame.rsv1 ? inflateRawSync(Buffer.concat([frame.payload, Buffer.from([0x00, 0x00, 0xff, 0xff])])) : frame.payload;
            decoded = JSON.parse(bytes.toString("utf8"));
          } catch {
            decoded = null;
          }
        }
        if (decoded === null) {
          client.write(frame.raw);
          continue;
        }
        const items: unknown[] = Array.isArray(decoded) ? decoded : [decoded];
        let touched = false;
        let closeAfter = false;
        const out: unknown[] = [];
        for (const item of items) {
          const record = item as Json | null;
          const id = record && (record._tag === "Chunk" || record._tag === "Exit") ? String(record.requestId) : null;
          const waiting = id ? pending.get(id) : undefined;
          if (!id || !waiting || !record) {
            out.push(item);
            continue;
          }
          touched = true;
          if (waiting.replace) {
            // Answered at request time; the server's own frames for this request are dropped.
            if (record._tag === "Exit") pending.delete(id);
            continue;
          }
          if (waiting.withheld) {
            if (record._tag === "Exit") {
              // The server applied the command; its reply is lost on the way back.
              waiting.entry.outcome = "reply-withheld-after-apply";
              closeAfter = true;
            }
            continue;
          }
          if (record._tag === "Exit") pending.delete(id);
          out.push(item);
        }
        if (!touched) client.write(frame.raw);
        else if (out.length) client.write(textFrame(JSON.stringify(Array.isArray(decoded) ? out : out[0])));
        if (closeAfter) {
          closeBoth();
          return;
        }
      }
    });
  }
}

type Outcome = { ok: true } | { ok: false; error: string; message: string };

/** One adapter call, recorded as what it refused with, or that it returned. */
async function attempt(call: () => Promise<unknown>): Promise<Outcome> {
  try {
    await call();
    return { ok: true };
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: name, message: message.slice(0, 240) };
  }
}

async function main() {
  const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1]! : "unlabelled";
  const root = mkdtempSync(join(scratchRoot(), "t3-prepared-parent-"));
  const evidence: Record<string, unknown> = { label, cases: {} as Record<string, unknown> };
  const cases = evidence.cases as Record<string, unknown>;
  const record = (name: string, facts: Record<string, unknown>) => {
    cases[name] = facts;
    console.log(JSON.stringify({ case: name, ...facts }));
  };
  const stage = (name: string) => process.stderr.write(`stage ${name}\n`);

  // The nightly's own server entry, extracted into this run's scratch.
  const bundle = join(root, "bundle");
  mkdirSync(bundle);
  extractArchive(asarPath, bundle);
  const metadata = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8")) as { version: string };
  assert.match(metadata.version, NIGHTLY, "the installed nightly line");
  evidence.installedVersion = metadata.version;
  evidence.archiveSha256 = createHash("sha256").update(readFileSync(asarPath)).digest("hex");
  const serverEntry = join(bundle, "apps/server/dist/bin.mjs");
  const t3Cli = join(root, "bin", "t3");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(t3Cli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverEntry)} "$@"\n`, { mode: 0o755 });

  // Private homes: T3's base directory, this run's HOME, the Nucleus data home and temp.
  const privateHome = join(root, "home");
  const t3Data = join(root, "t3-data");
  const nucleusData = join(root, "ns");
  const tmp = join(root, "tmp");
  for (const path of [privateHome, t3Data, nucleusData, tmp]) mkdirSync(path, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: privateHome,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CONFIG_HOME: join(privateHome, ".config"),
    XDG_DATA_HOME: join(privateHome, ".local/share"),
    XDG_CACHE_HOME: join(privateHome, ".cache"),
    T3CODE_HOME: t3Data,
    T3CODE_NO_BROWSER: "true",
    T3CODE_LOG_LEVEL: "Warn",
    NUCLEUS_DATA_HOME: nucleusData,
  };
  // The Nucleus ACP command the parent provider launches: the checkout's own marked command.
  const acpLauncher = join(root, "bin", "nucleus-acp");
  writeFileSync(
    acpLauncher,
    `#!/bin/sh\n# nucleus-owned-command-v1\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(join(checkout, "node_modules/tsx/dist/loader.mjs"))} ${JSON.stringify(join(checkout, "bin/nucleus-acp.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(nucleusData, "settings.json"), JSON.stringify({ daemonUrl: "ws://127.0.0.1:6767/ws" }, null, 2), { mode: 0o600 });

  // A synthetic repository and the task checkout (a worktree of it).
  const repository = join(root, "synthetic-repository");
  const taskDir = join(root, "task-worktree");
  mkdirSync(repository);
  const git = async (argv: string[]) => await run(["git", ...argv], { env: { ...environment, GIT_TERMINAL_PROMPT: "0" }, cwd: repository });
  await git(["init", "--quiet", "."]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "user.name", "Synthetic fixture"]);
  writeFileSync(join(repository, "fixture.txt"), "Synthetic private proof\n");
  await git(["add", "fixture.txt"]);
  await git(["commit", "--quiet", "-m", "Synthetic fixture"]);
  await git(["worktree", "add", "--quiet", "-b", "proof-task-worktree", taskDir]);

  let server: ChildProcess | null = null;
  let service: QueueService | null = null;
  let relay: Relay | null = null;
  let host: T3CodeHost | null = null;
  let direct: T3RpcClient | null = null;
  let rowStore: Store | null = null;
  const logPath = join(root, "t3-server.log");
  const collect = (chunk: Buffer) => writeFileSync(logPath, String(chunk).replace(/pairingUrl:\S+|#token=\S+/g, "[redacted]"), { flag: "a" });
  try {
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    stage("server");
    server = spawn(process.execPath, [serverEntry, "--base-dir", t3Data, "--host", "127.0.0.1", "--port", String(port), "--no-browser"], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout!.on("data", collect);
    server.stderr!.on("data", collect);
    const descriptor = (await until(async () => {
      const response = await fetch(`${endpoint}/.well-known/t3/environment`).catch(() => null);
      return response?.ok ? ((await response.json()) as { environmentId: string; serverVersion: string }) : null;
    }, "the isolated T3Code server")) as { environmentId: string; serverVersion: string };
    assert.match(descriptor.serverVersion, NIGHTLY);
    evidence.target = { serverVersion: descriptor.serverVersion, environmentId: descriptor.environmentId, isolated: true };
    const hostId = `t3code:${descriptor.environmentId}`;

    const session = JSON.parse(
      await run(
        [process.execPath, serverEntry, "auth", "session", "issue", "--base-dir", t3Data, "--scope", "orchestration:read", "--scope", "orchestration:operate",
          "--scope", "providers:manage", "--label", "proof-1460", "--ttl", "1h", "--json"],
        { env: environment, cwd: root, secret: true },
      ),
    ) as { token: string };
    const bearer = session.token;

    // The Nucleus service, in-process, serving the ACP callback socket for this data home.
    stage("service");
    service = new QueueService({ owner: { dataDir: nucleusData, timers: false }, fixture: "fake", debug: true });
    await service.start();
    const tick = async () => {
      await service!.debug({ target: "runtime", method: "ensureBootstrap", args: [] }).catch(() => undefined);
    };
    const whileTicking = async <T,>(work: Promise<T>): Promise<T> => {
      const timer = setInterval(() => void tick(), 2_000);
      try {
        await tick();
        return await work;
      } finally {
        clearInterval(timer);
      }
    };
    const health = () => service!.health() as unknown as { t3code?: { id?: string | null; connected?: boolean } };

    // The parent provider, installed through the operator's own route against this private server.
    stage("install");
    const install = JSON.parse(
      (await whileTicking(run([process.execPath, join(checkout, "bin/nucleus-t3.mjs"), "t3", "install", "--base-dir", t3Data,
        "--t3", t3Cli, "--acp-command", acpLauncher, "--json"], { env: environment, cwd: root }))).trim(),
    ) as { steps: unknown };
    await until(async () => {
      await tick();
      return health().t3code?.connected === true && health().t3code?.id === hostId ? true : null;
    }, "the service to adopt the private T3Code", 90_000);
    evidence.install = install.steps;

    // Synthetic Nucleus tasks in the service's store, each checked out in the worktree.
    const planning = "a".repeat(40);
    const newTask = async (name: string): Promise<string> => {
      const task = (await service!.debug({ target: "store", method: "insert", args: [submissionSchema.parse({
        submissionId: `prepared-parent-${name}-${randomUUID()}`, title: `Prepared parent ${name}`, repoPath: repository,
        planningCommit: planning, brief: { text: "Synthetic prepared parent proof" }, originAgentId: "proof-origin" }), hostId, "brief", planning] })) as { id: string };
      await service!.debug({ target: "store", method: "update", args: [task.id, { directory: taskDir, phase: "working" }] });
      return task.id;
    };
    await service.debug({ target: "store", method: "setMeta", args: ["paused", false] });

    // The adapter's ACP surface: the same AcpSessions the service uses, over the same store.
    rowStore = new Store(join(nucleusData, "queue.sqlite"));
    const acp = new AcpSessions({ store: rowStore } as unknown as Engine, { dataHome: nucleusData, socketPath: join(nucleusData, "callback.sock") });

    direct = new T3RpcClient({ endpoint, bearer, timeoutMs: 60_000 });
    await direct.connect();
    relay = new Relay(port);
    await relay.start();
    const relayEndpoint = `http://127.0.0.1:${relay.port}`;

    const projectId = `prepared-parent-project-${randomUUID()}`;
    await direct.call("projects.mutate", { type: "project.create", commandId: randomUUID(), projectId, title: "Synthetic prepared parent", workspaceRoot: repository });

    host = new T3CodeHost({ endpoint: relayEndpoint, bearer, statePath: join(root, "host.json"), timeoutMs: 30_000, acp: () => acp });
    stage("adapter-connect");
    await host.connect();
    const workspace = await host.createWorkspace({ title: "Prepared parent proof", requestId: `workspace-${randomUUID()}`, directory: taskDir, project: { projectId } });
    const workspaceRecord = host.state.read().workspaces[workspace.id]!;
    assert.equal(workspaceRecord.projectId, projectId);
    // The child role runs on the registered parent provider's listed model.
    const profile = { id: "synthetic-profile", name: "Synthetic", provider: PARENT_PROVIDER, model: PARENT_MODEL, available: true, problem: "", notes: "", supportedThinking: [] } as Profile;
    const spec = (taskId: string, requestId: string): HostAgentSpec => ({
      workspaceId: workspace.id,
      profile,
      title: "Synthetic task",
      taskNumber: 1460,
      mcpBindingPath: null,
      attempt: () => ({ requestId, prompt: "Do the work", labels: storedT3Labels("worker", { taskId, runId: `${taskId}-worker` }), environment: {} }),
    });
    const parentThreadId = (taskId: string) => identity("thread", canonical([hostId, taskId, "parent"]));
    const parentLaunchId = (taskId: string) => identity("parent-launch", canonical([hostId, taskId]));
    const taskOf = (taskId: string): Task =>
      ({ id: taskId, workspaceId: workspace.id, directory: taskDir, phase: "working", removedAt: null, resolution: { mergedCommit: null } }) as unknown as Task;
    /** The durable state a crash leaves: the binding stored before the parent's launch read, no launch intent. */
    const seedPrepared = (taskId: string) => {
      const bound = acp.bind({ taskId, ...parentPromptRules() });
      host!.state.update((state) => {
        state.parents = {
          ...state.parents,
          [taskId]: {
            taskId,
            threadId: parentThreadId(taskId),
            holdText: HOLD_MARKER,
            sessionId: bound.sessionId,
            bindingPath: bound.bindingPath,
            workspaceId: workspace.id,
            projectId,
            directory: taskDir,
            createdAt: new Date().toISOString(),
            title: "Synthetic task",
          },
        };
      });
    };
    /** Whether T3 holds the thread, read straight from the isolated server with the reported read. */
    const threadOnServer = async (threadId: string): Promise<{ present: boolean; remoteTag?: string }> => {
      try {
        let present = false;
        await direct!.readStream("orchestration.subscribeThread", { threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true }, (value) => {
          const frame = value as { kind?: string };
          if (frame.kind === "snapshot") present = true;
          return frame.kind === "synchronized";
        });
        return { present };
      } catch (error) {
        return { present: false, remoteTag: (error as { remoteTag?: string }).remoteTag };
      }
    };
    /** A live parent, launched directly with the same payload the adapter's launch sends. */
    const launchParentDirect = async (taskId: string) => {
      const threadId = parentThreadId(taskId);
      await direct!.call("orchestration.launchThread", {
        commandId: randomUUID(),
        threadId,
        projectId,
        title: "Synthetic task",
        modelSelection: { instanceId: PARENT_PROVIDER, model: PARENT_MODEL },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "existing_worktree", worktreePath: taskDir },
        initialMessage: { messageId: randomUUID(), text: HOLD_MARKER, attachments: [] },
      });
      return threadId;
    };
    const logOf = (threadId: string) => relay!.sent.filter((entry) => entry.threadId === threadId).map((entry) => `${entry.tag}:${entry.outcome}`);
    const stateOf = (taskId: string) => ({
      binding: Boolean(host!.state.read().parents?.[taskId]),
      launchIntent: host!.state.read().intents[parentLaunchId(taskId)]?.status ?? null,
      archivedAt: host!.state.read().parents?.[taskId]?.archivedAt ?? null,
    });

    // 0. The reported wire shape, read from the installed nightly.
    stage("case-0");
    const absent = await threadOnServer("prepared-parent-absent-probe");
    record("0-reported-absent-read", { ...absent, expectedGenericAbsent: GENERIC_ABSENT });

    // 1. Ordinary worker create over a prepared, unsent binding.
    stage("case-1");
    const t1 = await newTask("worker");
    seedPrepared(t1);
    const t1Parent = parentThreadId(t1);
    const first1 = await attempt(() => host!.createAgent(spec(t1, "worker-create-1460-1")));
    const afterFirst1 = await threadOnServer(t1Parent);
    const sentFirst1 = relay.count("orchestration.launchThread", t1Parent);
    const second1 = await attempt(() => host!.createAgent(spec(t1, "worker-create-1460-1")));
    record("1-ordinary-worker-prepared", {
      first: { ...first1, launchSent: sentFirst1 },
      parentOnServerAfterFirst: afterFirst1,
      second: { ...second1, launchSent: relay.count("orchestration.launchThread", t1Parent) },
      state: stateOf(t1),
    });

    // 2. Owner restart precheck over a prepared binding, then the worker create.
    stage("case-2");
    const t2 = await newTask("restart");
    seedPrepared(t2);
    const t2Parent = parentThreadId(t2);
    const restore2 = await attempt(() => host!.nesting.restoreForRestart(taskOf(t2), `owner-op-1460-${randomUUID()}`, () => true));
    const restoreSends = { launchThread: relay.count("orchestration.launchThread", t2Parent), unarchive: relay.count("orchestration.dispatchCommand", t2Parent) };
    const create2 = await attempt(() => host!.createAgent(spec(t2, "worker-create-1460-2")));
    record("2-owner-restart-prepared", {
      restore: { ...restore2, sendsDuringRestore: restoreSends },
      create: { ...create2, launchSent: relay.count("orchestration.launchThread", t2Parent) },
      state: stateOf(t2),
    });

    // 3. A live parent whose narrow read is unreadable: the wait, never a second parent.
    stage("case-3");
    const t3 = await newTask("live");
    const t3Parent = await launchParentDirect(t3);
    seedPrepared(t3);
    relay.replaceReply = [{ tag: "orchestration.subscribeThread", threadId: t3Parent, error: GENERIC_ABSENT }];
    const mark3 = relay.sent.length;
    const create3 = await attempt(() => host!.createAgent(spec(t3, "worker-create-1460-3")));
    relay.replaceReply = [];
    record("3-live-unreadable", {
      trace: relay.sent.slice(mark3).map((entry) => `${entry.tag}|${entry.threadId ?? "-"}|${entry.outcome}`),
      relayLog: logOf(t3Parent),
      create: { ...create3, launchSent: relay.count("orchestration.launchThread", t3Parent) },
      parentOnServer: await threadOnServer(t3Parent),
      state: stateOf(t3),
    });

    // 4. A prepared binding whose complete inventory cannot be read: the archived snapshot
    // answers with the generic incomplete read (injected at the relay, nothing else changed).
    stage("case-4");
    const t4 = await newTask("inventory");
    seedPrepared(t4);
    const t4Parent = parentThreadId(t4);
    relay.replaceReply = [{ tag: "orchestration.getArchivedShellSnapshot", error: GENERIC_ABSENT }];
    const create4 = await attempt(() => host!.createAgent(spec(t4, "worker-create-1460-4")));
    relay.replaceReply = [];
    record("4-inventory-unavailable", {
      relayLog: logOf(t4Parent),
      create: { ...create4, launchSent: relay.count("orchestration.launchThread", t4Parent) },
      parentOnServer: await threadOnServer(t4Parent),
      state: stateOf(t4),
    });
    const retry4 = await attempt(() => host!.createAgent(spec(t4, "worker-create-1460-4")));
    record("4-after-inventory-restored", { retry: { ...retry4, launchSent: relay.count("orchestration.launchThread", t4Parent) } });

    // 5a. Lost send receipt, applied: the server commits the launch and the reply is lost.
    stage("case-5a");
    const t5a = await newTask("applied");
    seedPrepared(t5a);
    const t5aParent = parentThreadId(t5a);
    relay.dropReply = [{ tag: "orchestration.launchThread", threadId: t5aParent }];
    const lost5a = await attempt(() => host!.createAgent(spec(t5a, "worker-create-1460-5a")));
    relay.dropReply = [];
    const applied5a = await threadOnServer(t5aParent);
    await host!.connect();
    const retry5a = await attempt(() => host!.createAgent(spec(t5a, "worker-create-1460-5a")));
    record("5a-lost-receipt-applied", {
      lost: { ...lost5a, launchSent: relay.count("orchestration.launchThread", t5aParent) },
      parentOnServerAfterLoss: applied5a,
      retry: { ...retry5a, launchSent: relay.count("orchestration.launchThread", t5aParent) },
      state: stateOf(t5a),
    });

    // 5b. Lost send receipt, unapplied: the request never reaches the server; it must never be resent.
    stage("case-5b");
    const t5b = await newTask("unapplied");
    seedPrepared(t5b);
    const t5bParent = parentThreadId(t5b);
    relay.dropRequest = [{ tag: "orchestration.launchThread", threadId: t5bParent }];
    const lost5b = await attempt(() => host!.createAgent(spec(t5b, "worker-create-1460-5b")));
    relay.dropRequest = [];
    await host!.connect();
    const retry5b = await attempt(() => host!.createAgent(spec(t5b, "worker-create-1460-5b")));
    record("5b-lost-receipt-unapplied", {
      relayLog: logOf(t5bParent),
      lost: { ...lost5b, launchSent: relay.count("orchestration.launchThread", t5bParent) },
      parentOnServer: await threadOnServer(t5bParent),
      retry: { ...retry5b, launchSent: relay.count("orchestration.launchThread", t5bParent) },
      state: stateOf(t5b),
    });

    // 6. First dispatch with no stored binding: the parent is minted and launched in one create.
    stage("case-6");
    const t6 = await newTask("fresh");
    const t6Parent = parentThreadId(t6);
    const create6 = await attempt(() => host!.createAgent(spec(t6, "worker-create-1460-6")));
    record("6-first-dispatch-fresh", {
      create: { ...create6, launchSent: relay.count("orchestration.launchThread", t6Parent) },
      parentOnServer: await threadOnServer(t6Parent),
      state: stateOf(t6),
    });

    evidence.result = "completed";
  } catch (error) {
    evidence.result = "failed";
    evidence.failure = (error instanceof Error ? error.message : String(error)).split(root).join("<proof-root>");
    throw error;
  } finally {
    host?.close();
    direct?.close();
    relay?.stop();
    rowStore?.close();
    await service?.stop().catch(() => undefined);
    if (server && server.exitCode === null) {
      const stopped = new Promise((done) => server!.once("exit", done));
      server.kill("SIGTERM");
      await stopped;
    }
    const evidencePath = join(root, `evidence-${label}.json`);
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2).split(root).join("<proof-root>"), { mode: 0o600 });
    console.log(JSON.stringify({ evidence: evidencePath, result: evidence.result, evidenceSha256: existsSync(evidencePath) ? createHash("sha256").update(readFileSync(evidencePath)).digest("hex") : null }));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
