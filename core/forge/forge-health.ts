/** One shared, short-lived GitHub Git-service observation for all task lanes. */
export class ForgeOutageError extends Error {
  constructor(readonly original: unknown) {
    super(
      "GitHub is unavailable; waiting for the shared Git service probe to recover",
    );
    this.name = "ForgeOutageError";
  }
}

let cached: { healthy: boolean; until: number } | undefined;
let pending: Promise<boolean> | undefined;
export async function githubHealthy(): Promise<boolean> {
  if (cached && Date.now() < cached.until) return cached.healthy;
  if (pending) return pending;
  pending = (async () => {
    let healthy = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(
        "https://github.com/github/gitignore.git/info/refs?service=git-upload-pack",
        {
          signal: controller.signal,
          redirect: "follow",
        },
      );
      healthy = response.ok;
    } catch {
      /* An unobservable service is not a healthy probe. */
    } finally {
      clearTimeout(timeout);
    }
    cached = { healthy, until: Date.now() + 10_000 };
    return healthy;
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}

/** Classify only network/forge failures; a definite SSH refusal is separately typed. */
export function isForgeNetworkFailure(error: unknown): boolean {
  const failure = error as { code?: unknown; stderr?: unknown } | null;
  const code = failure?.code;
  if (
    typeof code === "string" &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENETUNREACH",
    ].includes(code)
  )
    return true;
  return /\bHTTP 5\d\d\b|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b|Could not resolve host|Failed to connect|error connecting to api\.github\.com/i.test(
    String(failure?.stderr ?? ""),
  );
}

/** A command boundary identifies the source; classification alone never authorizes a repeat. */
export class GitTransientError extends Error {
  constructor(readonly kind: 'lock' | 'ssh' | 'network', readonly original: unknown, readonly deliveryUnknown = false) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
    this.name = 'GitTransientError';
  }
}
export class ReviewPublicationTransientError extends GitTransientError {
  constructor(error: unknown) { super('network', error, true); }
}
export function classifyGitTransientFailure(error: unknown): 'lock' | 'ssh' | 'network' | null {
  if (error instanceof GitTransientError) return error.kind;
  if (error instanceof ForgeOutageError) return classifyGitTransientFailure(error.original);
  if (error instanceof Error && error.cause && error.cause !== error) return classifyGitTransientFailure(error.cause);
  return null;
}
export function classifyGitCommandFailure(error: unknown): 'lock' | 'ssh' | 'network' | null {
  const failure = error as { stderr?: unknown; message?: unknown } | null;
  const detail = `${String(failure?.stderr ?? '')}\n${String(failure?.message ?? '')}`;
  if (/\.git(?:\/[^\s:'"]+)*\/[^\s:'"]+\.lock.*?(?:file exists|already exists)/i.test(detail)) return 'lock';
  if (/SSH authentication retry budget exhausted/.test(detail)) return 'ssh';
  if (isForgeNetworkFailure(error) || isForgeNetworkFailure({ stderr: detail }) || error instanceof Error && error.cause && classifyGitCommandFailure(error.cause) === 'network') return 'network';
  return null;
}

/** Delivery uncertainty survives wrappers without turning diagnostics into authority. */
export function gitDeliveryUnknown(error: unknown): boolean {
  if (error instanceof GitTransientError) return error.deliveryUnknown;
  if (error instanceof ForgeOutageError) return gitDeliveryUnknown(error.original);
  return error instanceof Error && Boolean(error.cause) && error.cause !== error && gitDeliveryUnknown(error.cause);
}
