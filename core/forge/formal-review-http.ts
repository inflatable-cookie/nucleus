/** Machine JSON for formal reviews. gh sanitizes JSON response strings for a
 * terminal, including literal Unicode escapes; findings identity needs the
 * original bytes. No response text is printed and no failed request is retried.
 */
export async function formalReviewHttp(endpoint: string, args: string[], token: string, request: typeof fetch = fetch): Promise<unknown> {
  const origin = 'https://api.github.com';
  let url = new URL(`${origin}/${endpoint}`);
  const originalPath = url.pathname;
  const namedInventory = originalPath.match(/^(\/repos\/[^/]+\/[^/]+)\/pulls\/([1-9]\d*)\/reviews$/);
  let canonicalPath: string | null = null;
  const body: Record<string, string> = {};
  let method = 'GET', paginate = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-X') method = args[++i]!;
    else if (arg === '-f') {
      const field = args[++i]!, split = field.indexOf('=');
      if (split < 1) throw Error('Invalid formal review field');
      body[field.slice(0, split)] = field.slice(split + 1);
    } else if (arg === '--paginate') paginate = true;
    else if (arg !== '--slurp') throw Error('Unsupported formal review request option');
  }
  const pages: unknown[] = [], seen = new Set<string>(), controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  // One aggregate budget for the complete inventory, including an identity
  // lookup if GitHub changes to its repository-ID pagination URL.
  let size = 0;
  const readJson = async (target: URL, requestMethod = 'GET') => {
    const response = await request(target, {
      method: requestMethod, redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'User-Agent': 'nucleus' },
      ...(requestMethod === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
    const chunks: Uint8Array[] = [];
    if (!response.body) throw Error('Formal review response is unavailable');
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) throw Error('Formal review response exceeds 32 MB');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) {
      let message = response.statusText;
      try { const value = JSON.parse(text); if (typeof value.message === 'string') message = value.message; } catch {}
      throw Error(`HTTP ${response.status}: ${message.slice(0, 300)}`);
    }
    const value: unknown = JSON.parse(text);
    return { response, value };
  };
  try {
    for (;;) {
      if (url.origin !== origin || url.username || url.password || seen.has(url.href) || seen.size >= 1000)
        throw Error('Formal review inventory pagination is invalid');
      seen.add(url.href);
      const { response, value } = await readJson(url, method);
      if (!paginate) return value;
      if (!Array.isArray(value)) throw Error('Formal review inventory is incomplete');
      pages.push(value);
      const link = response.headers.get('link');
      if (!link) return pages;
      const links = link.split(',').map(part => part.match(/^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/));
      if (links.some(part => !part)) throw Error('Formal review inventory pagination is invalid');
      const next = links.filter(part => part![2]!.split(' ').includes('next'));
      if (!next.length) return pages;
      if (next.length !== 1) throw Error('Formal review inventory pagination is invalid');
      const target = new URL(next[0]![1]!, url);
      if (target.origin !== origin || target.username || target.password)
        throw Error('Formal review inventory pagination is invalid');
      if (target.pathname !== originalPath) {
        // A numeric repository path is only an alias after the original named
        // repository identifies that exact ID. Never learn identity from an
        // arbitrary next link or allow a later page to change the ID or PR.
        const canonical = target.pathname.match(/^\/repositories\/([1-9]\d*)\/pulls\/([1-9]\d*)\/reviews$/);
        if (!namedInventory || !canonical || canonical[2] !== namedInventory[2])
          throw Error('Formal review inventory pagination changed the resource');
        if (!canonicalPath) {
          const { value: repository } = await readJson(new URL(namedInventory[1]!, origin));
          const id = repository && typeof repository === 'object' && 'id' in repository ? repository.id : null;
          if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
            throw Error('Formal review repository identity is unavailable');
          canonicalPath = `/repositories/${id}/pulls/${namedInventory[2]}/reviews`;
        }
        if (target.pathname !== canonicalPath) throw Error('Formal review inventory pagination changed the resource');
      }
      url = target;
    }
  } finally { clearTimeout(timeout); }
}
