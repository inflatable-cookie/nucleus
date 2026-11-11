import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostRegistry, resolveOriginHost, type KnownHost, type OriginLookup } from '../core/host/host-registry';

type FixtureHost = { knows: string[]; answer?: OriginLookup; fail?: boolean };
function fixture(hosts: Array<[string, FixtureHost]>) {
  let known: readonly KnownHost[] = [];
  const registry = new HostRegistry<FixtureHost>({ read: () => known, write: value => { known = value; }, transaction: fn => fn() });
  const sessions = new Map<string, object>();
  for (const [id, host] of hosts) {
    known = [...known, { id, endpoint: `${id}-endpoint` }];
    sessions.set(id, registry.connect(id, `${id}-endpoint`, host));
  }
  const lookup = async (host: FixtureHost, id: string) => {
    if (host.fail) throw new Error('transport closed');
    if (host.answer) return host.answer;
    return host.knows.includes(id) ? 'mine' as const : 'not-mine' as const;
  };
  return { registry, lookup, sessions };
}
/** A Paseo identity names the `paseo` host; the evidence describes that identity only. */
const paseoIdentity = { hostId: 'paseo:alpha', source: 'caller identity source paseo' };

test('origin host requires a complete unique observation across known hosts', async () => {
  const { registry, lookup, sessions } = fixture([['a', { knows: ['origin'] }], ['b', { knows: [] }]]);
  assert.equal(await resolveOriginHost(registry, 'origin', lookup), 'a');
  registry.get('b')!.knows.push('origin');
  assert.equal(await resolveOriginHost(registry, 'origin', lookup), undefined);
  registry.disconnect('a', sessions.get('a')!);
  assert.equal(await resolveOriginHost(registry, 'origin', lookup), undefined);
});

test('a host that authoritatively has no such thread is not-mine, and one mine with the rest not-mine resolves', async () => {
  const { registry, lookup } = fixture([['paseo:alpha', { knows: ['planner'] }], ['t3code:nightly', { knows: [] }]]);
  assert.equal(await resolveOriginHost(registry, 'planner', lookup), 'paseo:alpha');
  // A legacy truthy/falsey lookup keeps its meaning.
  const legacy = async (host: FixtureHost, id: string) => host.knows.includes(id) ? { id } : null;
  assert.equal(await resolveOriginHost(registry, 'planner', legacy), 'paseo:alpha');
});

test('two hosts claiming one identity is a refusal', async () => {
  const { registry, lookup } = fixture([['paseo:alpha', { knows: ['planner'] }], ['t3code:nightly', { knows: ['planner'] }]]);
  assert.equal(await resolveOriginHost(registry, 'planner', lookup), undefined);
});

test('an unknown read with no other evidence is a refusal', async () => {
  const { registry, lookup } = fixture([['paseo:alpha', { knows: ['planner'] }], ['t3code:nightly', { answer: 'unknown' }]]);
  assert.equal(await resolveOriginHost(registry, 'planner', lookup), undefined);
  const failed = fixture([['paseo:alpha', { knows: ['planner'] }], ['t3code:nightly', { fail: true }]]);
  assert.equal(await resolveOriginHost(failed.registry, 'planner', failed.lookup), undefined);
});

test('an offline host with no evidence leaves the origin unknown', async () => {
  const { registry, lookup, sessions } = fixture([['paseo:alpha', { knows: ['planner'] }], ['t3code:nightly', { knows: [] }]]);
  registry.disconnect('t3code:nightly', sessions.get('t3code:nightly')!);
  assert.equal(await resolveOriginHost(registry, 'planner', lookup), undefined);
});

test('an offline host that is not the claimant does not block a caller-named host', async () => {
  const { registry, lookup, sessions } = fixture([['paseo:alpha', { knows: ['planner'] }], ['t3code:nightly', { knows: [] }]]);
  registry.disconnect('t3code:nightly', sessions.get('t3code:nightly')!);
  assert.equal(await resolveOriginHost(registry, 'planner', lookup, paseoIdentity), 'paseo:alpha');
  // Evidence naming the offline host contradicts the claimant, so it decides nothing in its favour.
  assert.equal(await resolveOriginHost(registry, 'planner', lookup, { hostId: 't3code:nightly', source: 'caller identity source t3code' }), undefined);
  // Stale evidence about a host this registry never knew decides nothing either.
  assert.equal(await resolveOriginHost(registry, 'planner', lookup, { hostId: 'paseo:gone', source: 'stale' }), undefined);
});

test('caller evidence never lets a second claimant or a wrong host through', async () => {
  const both = fixture([['paseo:alpha', { knows: ['planner'] }], ['t3code:nightly', { knows: ['planner'] }]]);
  assert.equal(await resolveOriginHost(both.registry, 'planner', both.lookup, paseoIdentity), undefined);
  const undecided = fixture([['paseo:alpha', { knows: ['other'] }], ['t3code:nightly', { knows: ['planner'] }]]);
  assert.equal(await resolveOriginHost(undecided.registry, 'planner', undecided.lookup, paseoIdentity), undefined);
});
