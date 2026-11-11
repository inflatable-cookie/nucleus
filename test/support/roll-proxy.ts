import { chmodSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { createFrameReader, encodeFrame } from "../../shared/service/protocol";

/**
 * A byte-pipe proxy for roll tests: the client connects to the proxy, the
 * proxy pipes frames to the real service socket, and named methods are
 * interfered with so a test can lose exactly one response. `lose-response`
 * lets the request reach the service and settles, then destroys the client
 * side before its reply arrives (the roll's lost response); `never-receive`
 * destroys the connection before the frame is piped (provably not received).
 * Everything else — auth, health, outcome asks, every other method — pipes
 * untouched in both directions.
 */
export interface RollProxy {
  server: Server;
  socketPath: string;
  /** How many frames this proxy interfered with, so a test can await the loss. */
  interfered: number;
  close: () => Promise<void>;
}

export type RollProxyMode = "lose-response" | "never-receive";

export async function startRollProxy(
  upstream: string,
  socketPath: string,
  interfere: Array<{ method: string; mode: RollProxyMode }>,
): Promise<RollProxy> {
  const proxy: RollProxy = {
    server: createServer(() => {}),
    socketPath,
    interfered: 0,
    close: () => new Promise<void>(resolve => proxy.server.close(() => resolve())),
  };
  proxy.server = createServer(clientSide => {
    const upstreamSide = connect(upstream);
    let doomedId: string | null = null;
    const toUpstream = createFrameReader(frame => {
      const hit = interfere.find(rule => (frame as { method?: string }).method === rule.method);
      if (!hit) return void upstreamSide.write(encodeFrame(frame));
      proxy.interfered++;
      if (hit.mode === "never-receive") {
        clientSide.destroy();
        upstreamSide.destroy();
        return;
      }
      doomedId = (frame as { id: string }).id;
      upstreamSide.write(encodeFrame(frame));
    }, () => { clientSide.destroy(); upstreamSide.destroy(); });
    const toClient = createFrameReader(frame => {
      if (doomedId !== null && (frame as { id?: string }).id === doomedId) {
        // The service settled this request and answered; the answer is lost here.
        clientSide.destroy();
        upstreamSide.destroy();
        return;
      }
      if (!clientSide.destroyed) clientSide.write(encodeFrame(frame));
    }, () => { clientSide.destroy(); upstreamSide.destroy(); });
    clientSide.on("data", chunk => toUpstream.feed(chunk));
    clientSide.on("error", () => {});
    clientSide.on("close", () => upstreamSide.destroy());
    upstreamSide.on("data", chunk => toClient.feed(chunk));
    upstreamSide.on("error", () => {});
    upstreamSide.on("close", () => { if (!clientSide.destroyed) clientSide.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.server.once("error", reject);
    proxy.server.listen(socketPath, () => resolve());
  });
  chmodSync(socketPath, 0o600);
  return proxy;
}
