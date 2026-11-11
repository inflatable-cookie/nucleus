import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { formalReviewHttp } from '../core/forge/formal-review-http';
import { reviewPublicationBody } from '../core/forge/index';
import type { Task, Run } from '../shared/contracts';

const head = 'a'.repeat(40);
const task = { id: 'task' } as Task;
const run = { id: 'reviewer', head } as Run;
const namedPath = '/repos/acme/app/pulls/74/reviews';
const canonicalPath = '/repositories/1300192/pulls/74/reviews';
const inventoryEndpoint = `${namedPath.slice(1)}?per_page=100`;
const findings = 'literal \\u0085 \\uFEFF \\u001b actual \u0085 \uFEFF \u001b \u0000 日本語 🐝\\ "quotes"\r\nnext\tline';

for (const status of ['changes_required', 'ready_to_merge'] as const) {
  test(`formal review machine transport preserves exact ${status} findings and verdict table`, async t => {
    const body = reviewPublicationBody(task, run, status, findings, [{ id: 'bytes', subject: findings,
      verdict: status === 'changes_required' ? 'fail' : 'pass', evidence: findings }]);
    let posts = 0, gets = 0, identities = 0;
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer fixture-token');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') {
        posts++;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(payload.body, body);
        assert.equal(payload.commit_id, head);
        assert.equal(payload.event, status === 'changes_required' ? 'REQUEST_CHANGES' : 'APPROVE');
        res.end(JSON.stringify({ id: 42, ...payload }));
      } else if (req.url === '/repos/acme/app') {
        identities++;
        res.end(JSON.stringify({ id: 1300192 }));
      } else {
        gets++;
        const url = new URL(req.url!, 'https://api.github.com');
        assert.equal(url.searchParams.get('per_page'), '100');
        assert.equal(url.pathname, gets === 1 ? namedPath : canonicalPath);
        if (gets < 3) res.setHeader('Link', `<https://api.github.com${canonicalPath}?per_page=100&page=${gets + 1}>; rel="next", <https://api.github.com${canonicalPath}?per_page=100&page=3>; rel="last"`);
        res.end(JSON.stringify(Array.from({length: gets < 3 ? 100 : 1}, (_, i) => ({ id: (gets - 1) * 100 + i + 1, body }))));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const request: typeof fetch = (url, options) => {
      const remote = new URL(String(url));
      return fetch(`http://127.0.0.1:${address.port}${remote.pathname}${remote.search}`, options);
    };
    const created = await formalReviewHttp(namedPath.slice(1), ['-X', 'POST', '-f', `body=${body}`, '-f', `commit_id=${head}`,
      '-f', `event=${status === 'changes_required' ? 'REQUEST_CHANGES' : 'APPROVE'}`], 'fixture-token', request) as {body: string};
    assert.equal(created.body, body);
    const pages = await formalReviewHttp(inventoryEndpoint, ['--paginate', '--slurp'], 'fixture-token', request) as {body: string}[][];
    assert.deepEqual(pages.map(page => page.length), [100, 100, 1]);
    assert.ok(pages.flat().every(review => review.body === body));
    assert.equal(posts, 1);
    assert.equal(gets, 3);
    assert.equal(identities, 1, 'the named repository authenticates its numeric alias once');
  });
}

for (const shape of ['foreign-next', 'loop', 'unavailable', 'lost-response', 'malformed', 'oversize'] as const) {
  test(`formal review transport refuses ${shape} without replay`, async () => {
    let requests = 0;
    const request: typeof fetch = async () => {
      requests++;
      if (shape === 'lost-response') throw Error('socket lost after send');
      if (shape === 'unavailable') return new Response('{"message":"Resource not accessible"}', { status: 403 });
      if (shape === 'malformed') return new Response('{');
      if (shape === 'oversize') return new Response('x'.repeat(32 * 1024 * 1024 + 1));
      return new Response('[]', { headers: { Link: `<${shape === 'loop' ? 'https://api.github.com/reviews' : 'https://elsewhere.example/reviews'}>; rel="next"` } });
    };
    await assert.rejects(formalReviewHttp('reviews', shape === 'lost-response' ? ['-X', 'POST', '-f', 'body=exact'] : ['--paginate', '--slurp'], 'secret', request));
    assert.equal(requests, 1);
  });
}


for (const target of [
  'https://elsewhere.example/repositories/1300192/pulls/74/reviews?page=2',
  'http://api.github.com/repositories/1300192/pulls/74/reviews?page=2',
  'https://user:secret@api.github.com/repositories/1300192/pulls/74/reviews?page=2',
  'https://api.github.com/repos/another/repo/pulls/74/reviews?page=2',
  'https://api.github.com/repositories/999/pulls/74/reviews?page=2',
  'https://api.github.com/repositories/1300192/pulls/75/reviews?page=2',
  'https://api.github.com/repositories/1300192/pulls/74/comments?page=2',
  'https://api.github.com/repositories/1300192/pulls/74/reviews/42?page=2',
]) {
  test(`canonical inventory refuses unrelated target ${target}`, async () => {
    const paths: string[] = [];
    const request: typeof fetch = async (url, options) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      assert.equal(options?.redirect, 'error');
      if (path === '/repos/acme/app') return new Response('{"id":1300192}');
      assert.equal(paths.length, 1, 'no next-page request may escape the original resource');
      return new Response('[]', {headers:{Link:`<${target}>; rel="next"`}});
    };
    await assert.rejects(formalReviewHttp(inventoryEndpoint, ['--paginate', '--slurp'], 'fixture', request), /pagination/);
    assert.equal(paths.filter(path => path !== '/repos/acme/app').length, 1);
  });
}

for (const shape of ['unavailable-identity', 'missing-id', 'wrong-id', 'changed-id', 'unavailable-page', 'invalid-page', 'lost-page', 'empty-body', 'aggregate-size', 'loop'] as const) {
  test(`canonical pagination keeps ${shape} inventory unproven`, async () => {
    let pages = 0, identities = 0;
    const request: typeof fetch = async (url, options) => {
      const path = new URL(String(url)).pathname;
      assert.equal(options?.method, 'GET');
      if (path === '/repos/acme/app') {
        identities++;
        if (shape === 'unavailable-identity') return new Response('unavailable', {status:503});
        return new Response(JSON.stringify(shape === 'missing-id' ? {} : {id:shape === 'wrong-id' ? 999 : 1300192}));
      }
      pages++;
      assert.ok(pages <= 2, 'no repeat or foreign page is requested');
      if (pages === 2) {
        if (shape === 'unavailable-page') return new Response('unavailable', {status:503});
        if (shape === 'invalid-page') return new Response('{}');
        if (shape === 'lost-page') throw Error('connection lost');
        if (shape === 'empty-body') return new Response(null);
      }
      const target = shape === 'changed-id' && pages === 2 ? canonicalPath.replace('1300192', '999') : canonicalPath;
      return new Response(JSON.stringify(shape === 'aggregate-size' ? [{body:'x'.repeat(600000)}] : []),
        {headers:{Link:`<https://api.github.com${target}?per_page=100&page=2>; rel="next"`}});
    };
    await assert.rejects(formalReviewHttp(inventoryEndpoint, ['--paginate', '--slurp'], 'fixture', request));
    assert.equal(identities, 1);
    assert.equal(pages, ['unavailable-identity', 'missing-id', 'wrong-id'].includes(shape) ? 1 : 2);
  });
}

test('formal review inventory accepts responses larger than one MiB', async () => {
  const body = 'x'.repeat(1024 * 1024);
  const result = await formalReviewHttp('reviews', ['--paginate', '--slurp'], 'token', async () => new Response(JSON.stringify([{body}])));
  assert.deepEqual(result, [[{body}]]);
});
