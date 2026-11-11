import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store, digest} from '../core/store/store';
import {
  publishFormalReview, publishReview, publishReviewOnce, reconcileFormalReviewPublication, verifyFormalReview, requiredMergeReview, readReviewerToken,
  reviewEventForStatus, reviewStateForStatus, reviewMarker, reviewPublicationBody,
  uniqueMarkedReview, validateFormalReview, REVIEWER_TOKEN_SERVICE, LEGACY_REVIEWER_TOKEN_SERVICE,
  type FormalReviewRuntime, type ReviewerSetting,
} from '../core/forge/index';
import {retainReviewPublication} from '../core/review/review-publication';
import {git} from '../core/git/index';
import {formalReviewHttp} from '../core/forge/formal-review-http';
import type {Task, Run, Completion} from '../shared/contracts';

type Call = {endpoint: string; args: string[]; token: string};
type Review = {id?: unknown; user?: {login?: string}; body?: unknown; commit_id?: unknown; state?: unknown};
const head = 'a'.repeat(40), reviewer: ReviewerSetting = {login: 'northstar-reviewer'};
const verifyPr = async () => ({url: 'https://github.com/acme/app/pull/1', head});

function repoFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-formal-review-'));
  const repo = join(dir, 'repo');
  return {dir, repo,
    async init() { await git(dir, 'init', '--initial-branch=main', repo); await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git'); },
    cleanup() { rmSync(dir, {recursive: true, force: true}); }};
}
function storeFixture(repo: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-formal-store-'));
  return {store: new Store(join(dir, 'queue.sqlite')), dir};
}
const task = (repoPath: string): Task => ({id: 'task-1', repoPath, branch: 'ns-task', baseBranch: 'main', directory: repoPath, resumePrNumber: 1,
  resolution: {review: null}} as unknown as Task);
const run = (id = 'review-run'): Run => ({id, taskId: 'task-1', role: 'reviewer', generation: 1, head, base: 'b'.repeat(40),
  agentId: 'review-agent', workspaceId: 'workspace', profile: null, status: 'finished', createdAt: '2026-01-01T00:00:00.000Z', lastObservedAt: null,
  active: false, idleSince: null, completion: null, released: true} as Run);
const completion = (over: Partial<Completion> = {}): Completion => ({eventId: 'review-event', taskId: 'task-1', runId: 'review-run',
  status: 'ready_to_merge', summary: 'Approved', head, reviewId: 42, ...over});
function ghStub(calls: Call[], responses: (endpoint: string, args: string[]) => Review | Review[] | Review[][]) {
  const runGh: NonNullable<FormalReviewRuntime['runGh']> = async (_task, endpoint, args, token) => {
    calls.push({endpoint, args, token});
    return responses(endpoint, args);
  };
  return runGh;
}
const field = (args: string[], key: string) => args.find(a => a.startsWith(`${key}=`))!.slice(key.length + 1);
const posted = (args: string[]) => args.includes('-X');

test('verdict status maps to the formal GitHub review event and state', () => {
  assert.equal(reviewEventForStatus('ready_to_merge'), 'APPROVE');
  assert.equal(reviewEventForStatus('changes_required'), 'REQUEST_CHANGES');
  assert.equal(reviewEventForStatus('blocked'), 'COMMENT');
  assert.equal(reviewStateForStatus('ready_to_merge'), 'APPROVED');
  assert.equal(reviewStateForStatus('changes_required'), 'CHANGES_REQUESTED');
  assert.equal(reviewStateForStatus('blocked'), 'COMMENTED');
});

test('publication pins the reviewed head, keeps the marker, and never stores the token', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), r = run(), calls: Call[] = [], token = 'ghs_formal_secret_token';
  const runGh = ghStub(calls, (endpoint, args) => posted(args)
    ? {id: 501, user: {login: reviewer.login}, commit_id: field(args, 'commit_id'),
       state: field(args, 'event') === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED', body: field(args, 'body')}
    : (() => { throw new Error(`unexpected ${endpoint}`); })());
  const id = await publishFormalReview(store, t1, r, 'ready_to_merge', 'Substantive findings', reviewer, () => true,
    {readToken: async () => token, runGh, verifyPr});
  assert.equal(id, 501);
  const post = calls.find(call => posted(call.args))!;
  assert.match(post.endpoint, /^repos\/acme\/app\/pulls\/1\/reviews$/);
  assert.equal(field(post.args, 'commit_id'), head, 'publication is pinned to the reviewed head');
  assert.equal(field(post.args, 'event'), 'APPROVE');
  assert.ok(field(post.args, 'body').includes(reviewMarker(t1, r.id, head, 'ready_to_merge')));
  assert.equal(post.token, token, 'the token is passed to the gh call as GH_TOKEN');
  const record = store.getMeta<{hash: string; reviewId?: number}>(`reviewPublication:${r.id}`)!;
  assert.deepEqual(record, {hash: digest(reviewPublicationBody(t1, r, 'ready_to_merge', 'Substantive findings')), reviewId: 501});
  assert.doesNotMatch(JSON.stringify(record), /ghs_formal_secret_token/);
});

test('a persisted publication intent recovers the single marked review without a duplicate POST', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), r = run(), body = reviewPublicationBody(t1, r, 'changes_required', 'Fix the links');
  store.setMeta(`reviewPublication:${r.id}`, {hash: digest(body)}); // Intent persisted before a lost side effect.
  const calls: Call[] = [];
  const runGh = ghStub(calls, (endpoint, args) => args.includes('--slurp')
    ? [[{id: 77, user: {login: reviewer.login}, commit_id: head, state: 'CHANGES_REQUESTED', body}]]
    : (() => { throw new Error(`unexpected ${endpoint}`); })());
  const id = await publishFormalReview(store, t1, r, 'changes_required', 'Fix the links', reviewer, () => true, {readToken: async () => 'tok', runGh, verifyPr});
  assert.equal(id, 77);
  assert.equal(calls.filter(call => posted(call.args)).length, 0, 'no duplicate review is posted');
  assert.equal(store.getMeta<{reviewId?: number}>(`reviewPublication:${r.id}`)?.reviewId, 77);
});

test('pending-intent recovery refuses a marked review whose findings changed from the persisted hash', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), r = run(), body = reviewPublicationBody(t1, r, 'ready_to_merge', 'Original findings');
  store.setMeta(`reviewPublication:${r.id}`, {hash: digest(body)});
  // A review carrying the marker exists, but its findings were edited between intent and recovery.
  const changed = body.replace('Original findings', 'Planted findings');
  const runGh = ghStub([], (endpoint, args) => args.includes('--slurp')
    ? [[{id: 88, user: {login: reviewer.login}, commit_id: head, state: 'APPROVED', body: changed}]]
    : (() => { throw new Error(`unexpected ${endpoint}`); })());
  await assert.rejects(publishFormalReview(store, t1, r, 'ready_to_merge', 'Original findings', reviewer, () => true, {readToken: async () => 'tok', runGh, verifyPr}),
    /does not match the persisted findings/);
  assert.equal(store.getMeta<{reviewId?: number}>(`reviewPublication:${r.id}`)?.reviewId, undefined, 'the changed review is never adopted');
});

test('a real gh permission failure keeps the actionable GitHub reason and names the org', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), token = 'ghs_env_only_token';
  // Shape of an execFile failure: the message is the command echo; the refusal is on stderr.
  const runGh = ghStub([], () => {
    const error = new Error('Command failed: gh api repos/acme/app/pulls/1/reviews\n') as Error & {stderr?: string};
    error.stderr = 'HTTP 403: Resource not accessible by personal access token (https://api.github.com/repos/acme/app/pulls/1/reviews)\n';
    throw error;
  });
  await assert.rejects(publishFormalReview(store, t1, run('real-gh'), 'ready_to_merge', 'Findings', reviewer, () => true, {readToken: async () => token, runGh, verifyPr}),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /org acme/);
      assert.match(message, /Resource not accessible by personal access token/, 'the actionable GitHub reason is kept');
      assert.doesNotMatch(message, /Command failed/, 'the command echo does not replace the reason');
      assert.doesNotMatch(message, /ghs_env_only_token/);
      return true;
    });
});

test('a permission refusal survives a command echo and findings that mention error', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), token = 'ghs_hidden_token';
  // The argv echo carries the review body's word "error"; the real refusal is on stderr.
  const refused = ghStub([], () => {
    const error = new Error('Command failed: gh api repos/acme/app/pulls/1/reviews -X POST -f body=Findings about error handling\n') as Error & {stderr?: string};
    error.stderr = 'HTTP 403: Resource not accessible by personal access token\n';
    throw error;
  });
  await assert.rejects(publishFormalReview(store, t1, run('echo-error'), 'ready_to_merge', 'Findings about error handling', reviewer, () => true, {readToken: async () => token, runGh: refused, verifyPr}),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Resource not accessible by personal access token/, 'GitHub stderr outranks the command echo');
      assert.doesNotMatch(message, /Command failed/, 'the argv echo is never the refusal');
      assert.doesNotMatch(message, /error handling/, 'the review body text is not mistaken for the refusal');
      assert.doesNotMatch(message, /ghs_hidden_token/);
      return true;
    });
  // A non-permission refusal still reports the command output rather than the echo.
  const missing = ghStub([], () => {
    const error = new Error('Command failed: gh api repos/acme/app/pulls/1/reviews\n') as Error & {stderr?: string};
    error.stderr = 'HTTP 404: Not Found\n';
    throw error;
  });
  await assert.rejects(publishFormalReview(store, t1, run('echo-404'), 'ready_to_merge', 'Findings', reviewer, () => true, {readToken: async () => token, runGh: missing, verifyPr}),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /HTTP 404: Not Found/);
      assert.doesNotMatch(message, /Command failed/);
      return true;
    });
});

test('verification checks the reviewer login, commit, state and marker, and recovers one marked review', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {dir} = storeFixture(fixture.repo); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const t1 = task(fixture.repo), r = run(), marker = reviewMarker(t1, r.id, head, 'ready_to_merge');
  const valid: Review = {id: 42, user: {login: reviewer.login}, commit_id: head, state: 'APPROVED', body: `Findings\n${marker}`};
  const runtime = (review: Review): FormalReviewRuntime => ({readToken: async () => 'tok', verifyPr,
    runGh: ghStub([], (endpoint) => endpoint.endsWith('/reviews/42') ? review : (() => { throw new Error('HTTP 404: Not Found'); })())});
  assert.equal(await verifyFormalReview(t1, r, completion(), reviewer, runtime(valid)), 42);
  for (const [label, broken] of [
    ['author', {...valid, user: {login: 'someone-else'}}],
    ['commit', {...valid, commit_id: 'c'.repeat(40)}],
    ['state', {...valid, state: 'COMMENTED'}],
    ['marker', {...valid, body: 'Findings without a marker'}],
  ] as const) await assert.rejects(verifyFormalReview(t1, r, completion(), reviewer, runtime(broken)), /Formal review/, label);
  // A neighbouring or absent numeric id is reconciled only from the one marked review.
  const recover: FormalReviewRuntime = {readToken: async () => 'tok', verifyPr, runGh: ghStub([], (endpoint) => endpoint.endsWith('/reviews/999')
    ? (() => { throw new Error('HTTP 404: Not Found'); })() : [[valid]])};
  assert.equal(await verifyFormalReview(t1, r, completion({reviewId: 999}), reviewer, recover), 42);
  assert.equal(uniqueMarkedReview([valid, {...valid, id: 43}], reviewer.login, marker).id, 42, 'a duplicate exact marker settles on the earliest');
  assert.equal(uniqueMarkedReview([{...valid, id: 43}, valid], reviewer.login, marker).id, 42);
  assert.throws(() => uniqueMarkedReview([{...valid, body: `${marker}\n${marker}`}], reviewer.login, marker), /exactly one/);
  validateFormalReview(valid, reviewer.login, marker, head, 'ready_to_merge');
});

test('the merge precheck requires the reviewer APPROVED review at the current head', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {dir} = storeFixture(fixture.repo); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const t1 = task(fixture.repo), r = run(), marker = reviewMarker(t1, r.id, head, 'ready_to_merge');
  const review = (over: Partial<Review> = {}): Review => ({id: 42, user: {login: reviewer.login}, commit_id: head, state: 'APPROVED', body: `Approved\n${marker}`, ...over});
  const mergeTask = {...t1, prHead: head, resolution: {review: {eventId: 'e', taskId: t1.id, runId: r.id, status: 'ready_to_merge', summary: 'ok', head, reviewId: 42}}} as unknown as Task;
  const runtime = (value: Review): FormalReviewRuntime => ({readToken: async () => 'tok', verifyPr, runGh: ghStub([], () => value)});
  await assert.doesNotReject(requiredMergeReview(mergeTask, reviewer, runtime(review())));
  await assert.rejects(requiredMergeReview(mergeTask, reviewer, runtime(review({state: 'CHANGES_REQUESTED'}))), /state/);
  await assert.rejects(requiredMergeReview(mergeTask, reviewer, runtime(review({commit_id: 'c'.repeat(40)}))), /pinned/);
  await assert.rejects(requiredMergeReview({...mergeTask, resolution: {review: null}} as unknown as Task, reviewer, runtime(review())), /does not approve merging/);
  // A review-skipping task is not exempt: an opted-in repository still needs the reviewer's approval.
  const skipped = {...mergeTask, skipPRReview: true, resolution: {review: null}} as unknown as Task;
  await assert.rejects(requiredMergeReview(skipped, reviewer, runtime(review())), /does not approve merging/);
  await assert.doesNotReject(requiredMergeReview(skipped, null, runtime(review())), 'a non-opted-in repository keeps the review-skipping lane');
});

test('keychain read prefers the new service, falls back to the legacy service, and refuses when both are missing', async t => {
  const org = 'acme';
  const calls: string[] = [];
  const reader = (items: Record<string, string>) => async (service: string) => { calls.push(service); return items[service] ?? ''; };
  assert.equal(await readReviewerToken(org, reader({[REVIEWER_TOKEN_SERVICE]: 'new-token', [LEGACY_REVIEWER_TOKEN_SERVICE]: 'legacy-token'})), 'new-token', 'the new service wins when both hold a token');
  assert.equal(await readReviewerToken(org, reader({[LEGACY_REVIEWER_TOKEN_SERVICE]: 'legacy-token'})), 'legacy-token', 'an existing token under the legacy service keeps working');
  await assert.rejects(readReviewerToken(org, reader({})),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, new RegExp(`org ${org}`));
      assert.match(message, new RegExp(REVIEWER_TOKEN_SERVICE.replace(/\./g, '\\.')));
      assert.match(message, new RegExp(LEGACY_REVIEWER_TOKEN_SERVICE.replace(/\./g, '\\.')), 'the refusal names the legacy fallback once');
      return true;
    });
  assert.deepEqual(calls.filter(service => service === REVIEWER_TOKEN_SERVICE).length, 3, 'the new service is read first every time');
});

test('a missing keychain item, 401/403 and missing write access refuse loudly, naming the org, with no comment fallback', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), token = 'ghs_leaky_token';
  // A missing keychain item names the org, the keychain service and what is missing.
  await assert.rejects(readReviewerToken(`ns-missing-${randomUUID()}`), new RegExp(`${REVIEWER_TOKEN_SERVICE}.*account`));
  for (const [index, failure] of ['HTTP 401: Bad credentials', 'HTTP 403: Resource not accessible by personal access token', 'Must have write access to this repository'].entries()) {
    const calls: Call[] = [];
    const runGh = ghStub(calls, () => { throw new Error(`${failure}: ${token}`); });
    await assert.rejects(publishFormalReview(store, t1, run(`review-run-${index}`), 'ready_to_merge', 'Findings', reviewer, () => true, {readToken: async () => token, runGh, verifyPr}),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /org acme/);
        assert.doesNotMatch(message, /ghs_leaky_token/, 'the token never appears in an error');
        return true;
      });
    assert.equal(calls.some(call => /comments/.test(call.endpoint)), false, 'a formal failure never falls back to a PR comment');
  }
});

for (const status of ['ready_to_merge', 'changes_required'] as const) for (const shape of ['absent', 'existing', 'lost-response', 'duplicate', 'mixed-login', 'foreign-login', 'bad-inventory', 'race', 'changed-head', 'wrong-state', 'wrong-head', 'mismatch', 'tamper'] as const) {
  test(`owner publication recovery: ${status}: ${shape}`, async t => {
    const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
    const {store, dir} = storeFixture(fixture.repo); t.after(() => {store.close(); rmSync(dir, {recursive:true, force:true});});
    const t1 = task(fixture.repo), r = run(), text = 'Authentic completed findings';
    r.completion = completion({status, reviewId:undefined, reviewText:text});
    store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(r.completion.eventId,t1.id,r.id,digest(JSON.stringify(r.completion)),JSON.stringify({accepted:true}));
    if(shape==='tamper') r.completion.summary = 'Tampered after receipt';
    store.putRun(r);
    const before = JSON.stringify(r.completion), body = reviewPublicationBody(t1, r, status, text);
    store.setMeta(`reviewPublication:${r.id}`, {hash:digest(body)});
    let posts = 0, lists = 0, permitted = true;
    const valid = {id:501, user:{login:reviewer.login}, commit_id:head, state:reviewStateForStatus(status), body};
    const runtime: FormalReviewRuntime = {readToken:async()=> 'secret', verifyPr:async()=>({url:'url',head:shape==='changed-head'?'c'.repeat(40):head}), runGh:async(_task,_endpoint,args)=> {
      if (posted(args)) { posts++; if(shape==='lost-response') throw Error('Unexpected end of JSON input'); return valid; }
      assert.equal(new URL(_endpoint, 'https://api.github.com/').searchParams.get('per_page'), '100');
      lists++;
      if(shape==='race' && lists===2) permitted=false;
      if(shape==='existing') return [[valid]];
      if(shape==='wrong-state') return [[{...valid,state:'COMMENTED'}]];
      if(shape==='wrong-head') return [[{...valid,commit_id:'b'.repeat(40)}]];
      if(shape==='mismatch') return [[{...valid,body:body.replace(text,'Altered findings')}]];
      if(shape==='duplicate') return [[valid, {...valid,id:502}]];
      if(shape==='mixed-login') return [[valid, {...valid,id:502,user:{login:'other'}}]];
      if(shape==='foreign-login') return [[{...valid,user:{login:'other'}}]];
      if(shape==='bad-inventory') return [{}];
      return [[]];
    }};
    const recover = () => reconcileFormalReviewPublication(store,t1,r,reviewer,'Explicit owner reconciliation',()=>permitted,runtime);
    if(shape==='absent'||shape==='existing'||shape==='duplicate'||shape==='mixed-login') {
      assert.equal(await recover(),501);
      assert.equal(posts,shape==='absent'?1:0);
    } else {
      await assert.rejects(recover());
      assert.equal(posts,shape==='lost-response'?1:0);
      if(shape==='lost-response') {await assert.rejects(recover(),/Unexpected end/);assert.equal(posts,2);assert.equal(lists,4,'every owner retry re-observes absence');}
    }
    assert.equal(JSON.stringify(store.run(r.id)!.completion),before,'publication never rewrites the authentic callback');
  });
}

test('a zero inventory never automatically reposts a persisted intent', async t=>{
  const fixture=repoFixture();await fixture.init();t.after(()=>fixture.cleanup());
  const {store,dir}=storeFixture(fixture.repo);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const t1=task(fixture.repo),r=run(),text='Original';
  store.setMeta(`reviewPublication:${r.id}`,{hash:digest(reviewPublicationBody(t1,r,'ready_to_merge',text))});
  let posts=0;
  await assert.rejects(publishFormalReview(store,t1,r,'ready_to_merge',text,reviewer,()=>true,{verifyPr,readToken:async()=> 'secret',runGh:async(_t,_e,args)=>{if(posted(args))posts++;return [[]];}}),/found 0/);
  assert.equal(posts,0);
});


for (const status of ['ready_to_merge', 'changes_required'] as const) {
  test(`forge reconciles ${status} from a canonical second inventory page without POST`, async t => {
    const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
    const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive:true, force:true}); });
    const t1 = task(fixture.repo), r = run(), text = 'Exact findings \\u0085';
    r.completion = completion({status, reviewId:undefined, reviewText:text});
    store.putRun(r);
    store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(r.completion.eventId,t1.id,r.id,digest(JSON.stringify(r.completion)),JSON.stringify({accepted:true}));
    const body = reviewPublicationBody(t1, r, status, text);
    store.setMeta(`reviewPublication:${r.id}`, {hash:digest(body)});
    const requests: string[] = [];
    const request: typeof fetch = async (target, options) => {
      assert.equal(options?.method, 'GET', 'an existing marked result never creates another review');
      const url = new URL(String(target)); requests.push(url.pathname);
      if (url.pathname === '/repos/acme/app') return new Response('{"id":1300192}');
      const valid = {id:501,user:{login:reviewer.login},commit_id:head,state:reviewStateForStatus(status),body};
      if (url.pathname === '/repos/acme/app/pulls/1/reviews') {
        assert.equal(url.searchParams.get('per_page'), '100');
        return new Response(JSON.stringify(Array.from({length:100},(_, i)=>({...valid,id:i+1,body:'Earlier unrelated findings'}))),
          {headers:{Link:'<https://api.github.com/repositories/1300192/pulls/1/reviews?per_page=100&page=2>; rel="next"'}});
      }
      assert.equal(url.pathname, '/repositories/1300192/pulls/1/reviews');
      return new Response(JSON.stringify([valid]));
    };
    const id = await reconcileFormalReviewPublication(store,t1,r,reviewer,'Reconcile original verdict',()=>true,{
      readToken:async()=> 'fixture',verifyPr,
      runGh:async(_task,endpoint,args,token)=>formalReviewHttp(endpoint,args,token,request),
    });
    assert.equal(id,501);
    assert.deepEqual(requests,['/repos/acme/app/pulls/1/reviews','/repos/acme/app','/repositories/1300192/pulls/1/reviews']);
    assert.deepEqual(store.getMeta(`reviewPublication:${r.id}`),{hash:digest(body),reviewId:501});
    assert.equal(store.run(r.id)!.completion!.status,status);
  });
}

// Task 704: one reviewer run posts one review, however many passes observe it.
const publicationHead = head;
function publicationRuntime(after: (endpoint: string, args: string[]) => unknown) {
  const runGh: NonNullable<FormalReviewRuntime['runGh']> = async (_task, endpoint, args) => after(endpoint, args);
  return {readToken: async () => 'tok', verifyPr, runGh} satisfies FormalReviewRuntime;
}
const accepting = (args: string[]): Review => ({id: 501, user: {login: reviewer.login}, commit_id: field(args, 'commit_id'),
  state: 'APPROVED', body: field(args, 'body')});

test('two concurrent publish calls for one run post one review', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), r = run(), calls: Call[] = [];
  let posts = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = publicationRuntime(async (endpoint, args) => {
    calls.push({endpoint, args, token: 'tok'});
    if (posted(args)) { posts++; await gate; return accepting(args); }
    return [[]];
  });
  const first = publishReview(store, t1, r, 'ready_to_merge', 'Findings', () => true, reviewer, runtime);
  const second = publishReview(store, t1, r, 'ready_to_merge', 'Findings', () => true, reviewer, runtime);
  release();
  assert.deepEqual(await Promise.all([first, second]), [501, 501], 'both passes reuse the one publication');
  assert.equal(posts, 1, 'the run posts exactly one review');
  assert.equal(calls.filter(call => posted(call.args)).length, 1);
  assert.deepEqual(store.getMeta(`reviewPublication:${r.id}`),
    {hash: digest(reviewPublicationBody(t1, r, 'ready_to_merge', 'Findings')), reviewId: 501});
});

test('a retry after a lost reply reuses the published review without a second POST', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), r = run(), key = `reviewPublication:${r.id}`;
  const existing: Review[] = [];
  let posts = 0;
  const runtime = publicationRuntime(async (_endpoint, args) => {
    if (posted(args)) { posts++; existing.push(accepting(args)); throw new Error('HTTP 500: unavailable'); }
    return [existing];
  });
  const { gitDeliveryUnknown, classifyGitTransientFailure } = await import('../core/forge/forge-health');
  await assert.rejects(publishReview(store, t1, r, 'ready_to_merge', 'Findings', () => true, reviewer, runtime), (error: unknown) => classifyGitTransientFailure(error) === 'network' && gitDeliveryUnknown(error));
  assert.equal(posts, 1);
  assert.equal(store.getMeta<{reviewId?: number}>(key)?.reviewId, undefined, 'the intent is retained without a reply');
  assert.equal(await publishReview(store, t1, r, 'ready_to_merge', 'Findings', () => true, reviewer, runtime), 501);
  assert.equal(posts, 1, 'the retry observes the existing review instead of posting again');
  assert.equal(store.getMeta<{reviewId?: number}>(key)?.reviewId, 501);
});

test('a pass that joins a publication flight reports no side effect of its own', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), r = run();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = publicationRuntime(async (_endpoint, args) => {
    if (posted(args)) { await gate; return accepting(args); }
    return [[]];
  });
  const first = publishReviewOnce(store, t1, r, 'ready_to_merge', 'Findings', () => true, reviewer, runtime);
  const joined = publishReviewOnce(store, t1, r, 'ready_to_merge', 'Findings', () => true, reviewer, runtime);
  release();
  assert.deepEqual(await Promise.all([first, joined]), [{id: 501, published: true}, {id: 501, published: false}]);
});

test('two reviews with this run marker settle on the earliest and leave the later one in place', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), r = run(), key = `reviewPublication:${r.id}`;
  const body = reviewPublicationBody(t1, r, 'ready_to_merge', 'Findings');
  store.setMeta(key, {hash: digest(body)}); // The intent both racing passes wrote before their POST.
  let posts = 0;
  // The later review is listed first: the record still takes the earliest one.
  const runtime = publicationRuntime(async (_endpoint, args) => {
    if (posted(args)) { posts++; return accepting(args); }
    return [[{id: 611, user: {login: reviewer.login}, commit_id: publicationHead, state: 'APPROVED', body},
      {id: 610, user: {login: reviewer.login}, commit_id: publicationHead, state: 'APPROVED', body}]];
  });
  assert.equal(await publishReview(store, t1, r, 'ready_to_merge', 'Findings', () => true, reviewer, runtime), 610);
  assert.equal(posts, 0, 'an existing same-marker review is never reposted');
  assert.deepEqual(store.getMeta(key), {hash: digest(body), reviewId: 610}, 'the earliest review is the record');
});

test('a repeat reuse of a recorded publication is silent', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), r = run();
  const body = reviewPublicationBody(t1, r, 'ready_to_merge', 'Findings');
  const runtime = publicationRuntime(async (_endpoint, args) => posted(args) ? accepting(args) : {id: 501, user: {login: reviewer.login},
    commit_id: publicationHead, state: 'APPROVED', body});
  const first = await publishReviewOnce(store, t1, r, 'ready_to_merge', 'Findings', () => true, reviewer, runtime);
  assert.deepEqual(first, {id: 501, published: true}, 'the pass that posts reports the side effect');
  const repeat = await publishReviewOnce(store, t1, r, 'ready_to_merge', 'Findings', () => true, reviewer, runtime);
  assert.deepEqual(repeat, {id: 501, published: false}, 'a repeat reuses the recorded publication silently');
});

test('the publication record settles two same-marker publications on the earliest and still refuses a real mismatch', async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const t1 = task(fixture.repo), r = run(), key = `reviewPublication:${r.id}`;
  const completed = completion({reviewText: 'Findings'});
  const hash = digest(reviewPublicationBody(t1, r, 'ready_to_merge', 'Findings'));
  assert.equal(retainReviewPublication(store, t1, r, completed, reviewer, 612), 612, 'the first record is written as-is');
  assert.equal(retainReviewPublication(store, t1, r, completed, reviewer, 611), 611, 'the later duplicate settles on the earliest');
  assert.deepEqual(store.getMeta(key), {hash, reviewId: 611});
  assert.equal(retainReviewPublication(store, t1, r, completed, reviewer, 611), 611, 'a repeat of the retained id is silent');
  assert.throws(() => retainReviewPublication(store, t1, r, completion({reviewText: 'Different findings'}), reviewer, 611),
    /Review publication record differs from the authenticated review/, 'a different body hash is a real mismatch');
  assert.throws(() => retainReviewPublication(store, t1, r, completed, null, 611),
    /Review publication record differs from the authenticated review/, 'a different publication kind is a real mismatch');
});

for (const late of [false, true]) test(`transient publication observes absence before resend; late original=${late}`, async t => {
  const fixture = repoFixture(); await fixture.init(); t.after(() => fixture.cleanup());
  const {store, dir} = storeFixture(fixture.repo); t.after(() => {store.close(); rmSync(dir, {recursive:true, force:true});});
  const t1 = task(fixture.repo), r = run(), text = 'Exact accepted findings';
  let posts = 0, lists = 0;
  const body = reviewPublicationBody(t1,r,'ready_to_merge',text);
  const valid = {id:501,user:{login:reviewer.login},commit_id:head,state:'APPROVED',body};
  const runtime: FormalReviewRuntime = {verifyPr, readToken:async()=> 'secret', runGh:async(_t,_e,args)=> {
    if (posted(args)) {
      posts++;
      if (posts===1) throw Error('HTTP 503: unavailable');
      assert.equal(lists,2,'each resend follows complete inventories');
      return valid;
    }
    lists++;
    return late && lists===2 ? [[valid]] : [[]];
  }};
  const publish = () => publishFormalReview(store,t1,r,'ready_to_merge',text,reviewer,()=>true,runtime);
  await assert.rejects(publish(),/HTTP 503/);
  assert.equal(await publish(),501);
  assert.equal(posts,late?1:2);
  assert.equal(store.getMeta<{reviewId:number}>(`reviewPublication:${r.id}`)?.reviewId,501);
});
