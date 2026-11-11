import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Leads } from '../core/planning/leads';
import { leadList, type Lead, type LeadPage } from '../shared/contracts';
// Walk the server's pages directly to exercise its cursor contract.
async function readPages(fetch: (input: { state: Lead["state"]; pageSize: number; before?: { createdAt: string; id: string } }) => Promise<LeadPage>, state: Lead["state"]): Promise<Lead[]> {
  const rows: Lead[] = [];
  let before: { createdAt: string; id: string } | undefined;
  do {
    const page = await fetch({ state, pageSize: 8, ...(before ? { before } : {}) });
    rows.push(...page.items);
    before = page.next ?? undefined;
  } while (before);
  return rows;
}

test('large lead backlog transfers every full brief through bounded cursor pages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-lead-pages-'));
  const store = new Store(join(root, 'queue.sqlite'));
  try {
    const leads = new Leads(store), repo = { origin: 'owner/app', path: '/fixture/app' };
    const body = 'x'.repeat(950_000);
    const added: Lead[] = [];
    for (let n = 0; n < 24; n++) added.push(leads.add({ repositories: [repo], title: `Lead ${n}`, body, lanes: [], author: 'operator' }));
    // Equal timestamps exercise the ID tie-break rather than an offset cursor.
    for (const lead of added) store.updateLead({ ...lead, version: 2, createdAt: '2026-10-11T00:00:00.000Z' }, 'operator');
    // An unpaged list too big for one response refuses with the paging recipe (lean audit 2026-10-15)
    // instead of failing at the 16 MiB transport bound.
    assert.throws(() => leads.list(leadList.input.parse({})), /24 open leads are 2\d\.\d MB, over one response; call lead\.list with pageSize \(1-8\), then again with before set to the returned next cursor/);
    assert.equal(leads.list(leadList.input.parse({ repository: 'owner/absent' })).length, 0, 'a small unpaged list keeps its array shape');
    const pages: Lead[][] = [];
    const rows = await readPages(async input => {
      const page = leads.list({ ...leadList.input.parse(input), pageSize: input.pageSize! });
      pages.push(page.items);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16 * 1024 * 1024);
      return page;
    }, 'open');
    assert.deepEqual(pages.map(page => page.length), [8, 8, 8, 0]);
    assert.equal(new Set(rows.map(row => row.id)).size, 24);
    assert.deepEqual(rows.map(row => row.id).sort(), added.map(row => row.id).sort());
    assert.ok(rows.every(row => row.body === body));
    assert.equal(leads.get({ id: added[0].id }).body, body);
    assert.equal(leads.list({ ...leadList.input.parse({ repository: 'owner/absent', pageSize: 8 }), pageSize: 8 }).items.length, 0);
    assert.equal(leads.list({ ...leadList.input.parse({ lane: 'absent', pageSize: 8 }), pageSize: 8 }).items.length, 0);
    assert.equal(leads.list({ ...leadList.input.parse({ state: 'promoted', pageSize: 8 }), pageSize: 8 }).items.length, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('cursor paging excludes new rows before the cursor and rejects invalid input', async () => {
  assert.equal(leadList.input.safeParse({ pageSize: 9 }).success, false);
  assert.equal(leadList.input.safeParse({ before: { createdAt: '2026-10-11T00:00:00.000Z', id: 'a' } }).success, false);
  const root = mkdtempSync(join(tmpdir(), 'queue-lead-cursor-'));
  const store = new Store(join(root, 'queue.sqlite'));
  try {
    const leads = new Leads(store), repo = { origin: 'owner/app', path: '/fixture/app' };
    const originals: Lead[] = [];
    for (let n = 0; n < 10; n++) originals.push(leads.add({ repositories: [repo], title: `Lead ${n}`, body: 'body', lanes: [], author: 'operator' }));
    let calls = 0;
    const rows = await readPages(async input => {
      if (++calls === 2) leads.add({ repositories: [repo], title: 'Arrived mid-read', body: 'new', lanes: [], author: 'operator' });
      return leads.list({ ...input, pageSize: input.pageSize! });
    }, 'open');
    assert.deepEqual(rows.map(row => row.id).sort(), originals.map(row => row.id).sort());
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('byte-budget pages preserve Unicode, escaped bodies and legacy timestamp cursors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-lead-byte-pages-'));
  const store = new Store(join(root, 'queue.sqlite'));
  try {
    const leads = new Leads(store), repo = { origin: 'owner/app', path: '/fixture/app' };
    const expected = new Map<string, string>();
    for (let n = 0; n < 8; n++) {
      const body = (n % 2 ? '\u0001' : '中').repeat(1_000_000);
      const lead = leads.add({ repositories: [repo], title: `Wide ${n}`, body, lanes: [], author: 'operator' });
      store.updateLead({ ...lead, version: 2, createdAt: '2026-10-10T00:00:00+00:00' }, 'operator');
      expected.set(lead.id, body);
    }
    let shortContinuation = false;
    const rows = await readPages(async input => {
      const parsed = leadList.input.parse(input);
      const page = leads.list({ ...parsed, pageSize: parsed.pageSize! });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16 * 1024 * 1024);
      assert.ok(page.items.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0) <= 8 * 1024 * 1024);
      if (page.items.length < 8 && page.next) shortContinuation = true;
      return page;
    }, 'open');
    assert.ok(shortContinuation, 'byte-shortened pages must continue');
    assert.equal(rows.length, 8);
    assert.equal(new Set(rows.map(row => row.id)).size, 8);
    for (const row of rows) assert.equal(row.body, expected.get(row.id));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


test('a large escape-heavy papercut record fits alone without blocking the board', async () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-lead-single-page-'));
  const store = new Store(join(root, 'queue.sqlite'));
  try {
    const leads = new Leads(store), repo = { origin: 'owner/app', path: '/fixture/app' };
    const body = '\u0001'.repeat(1_000_000);
    const lead = leads.add({ repositories: [repo], title: 'Repeated papercut text', body, lanes: [], author: 'operator' });
    store.updateLead({ ...lead, version: 2, papercut: { area: 'queue', happened: body, impact: '', fix: '', source: null, draftId: null } }, 'operator');
    const other = leads.add({ repositories: [repo], title: 'Other', body: 'small', lanes: [], author: 'operator' });
    let sawLargeSingle = false;
    const rows = await readPages(async input => {
      const page = leads.list({ ...input, pageSize: input.pageSize! });
      const bytes = Buffer.byteLength(JSON.stringify(page));
      assert.ok(bytes < 16 * 1024 * 1024);
      if (bytes > 8 * 1024 * 1024) {
        assert.equal(page.items.length, 1);
        sawLargeSingle = true;
      }
      leadList.output.parse(page);
      return page;
    }, 'open');
    assert.ok(sawLargeSingle);
    assert.deepEqual(rows.map(row => row.id).sort(), [lead.id, other.id].sort());
    assert.equal(rows.find(row => row.id === lead.id)?.papercut?.happened, body);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
