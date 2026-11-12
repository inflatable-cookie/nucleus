import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgentId } from '../shared/agent-identity';
import { HostRegistry, identitySourceHostEvidence, resolveOriginHost, type KnownHost, type OriginLookup } from '../core/host/host-registry';

type FixtureHost = { knows?: string[]; answer?: OriginLookup; fail?: boolean };
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
    return host.knows?.includes(id) ? 'mine' as const : 'not-mine' as const;
  };
  return { registry, lookup, sessions };
}
/** A Paseo identity names the `paseo` host; the evidence describes that identity only. */
const paseoIdentity = { hostId: 'paseo:alpha', source: 'caller identity source paseo' };

test('origin host requires a complete unique observation across known hosts', async () => {
  const { registry, lookup, sessions } = fixture([['a', { knows: ['origin'] }], ['b', { knows: [] }]]);
  assert.equal(await resolveOriginHost(registry, 'origin', lookup), 'a');
  registry.get('b')!.knows!.push('origin');
  assert.equal(await resolveOriginHost(registry, 'origin', lookup), undefined);
  registry.disconnect('a', sessions.get('a')!);
  assert.equal(await resolveOriginHost(registry, 'origin', lookup), undefined);
});

test('a host that authoritatively has no such thread is not-mine, and one mine with the rest not-mine resolves', async () => {
  const { registry, lookup } = fixture([['paseo:alpha', { knows: ['planner'] }], ['t3code:nightly', { knows: [] }]]);
  assert.equal(await resolveOriginHost(registry, 'planner', lookup), 'paseo:alpha');
  // A legacy truthy/falsey lookup keeps its meaning.
  const legacy = async (host: FixtureHost, id: string) => host.knows?.includes(id) ? { id } : null;
  assert.equal(await resolveOriginHost(registry, 'planner', legacy), 'paseo:alpha');
});

test('two hosts claiming one identity is a refusal', async () => {
  const { registry, lookup } = fixture([['paseo:alpha', { knows: ['planner'] }], ['paseo:beta', { knows: ['planner'] }]]);
  assert.equal(await resolveOriginHost(registry, 'planner', lookup), undefined);
});

test('an unknown read with no other evidence is a refusal', async () => {
  const { registry, lookup } = fixture([['paseo:alpha', { knows: ['planner'] }], ['paseo:beta', { answer: 'unknown' }]]);
  assert.equal(await resolveOriginHost(registry, 'planner', lookup), undefined);
  const failed = fixture([['paseo:alpha', { knows: ['planner'] }], ['paseo:beta', { fail: true }]]);
  assert.equal(await resolveOriginHost(failed.registry, 'planner', failed.lookup), undefined);
});

test('a bare legacy Paseo origin resolves despite an unrelated offline T3 host', async () => {
  const { registry, lookup, sessions } = fixture([['paseo:alpha', { knows: ['planner'] }], ['t3code:nightly', { knows: [] }]]);
  registry.disconnect('t3code:nightly', sessions.get('t3code:nightly')!);
  assert.equal(await resolveOriginHost(registry, 'planner', lookup), 'paseo:alpha');
  const multiplePaseo = fixture([['paseo:alpha', { knows: ['planner'] }], ['paseo:beta', { knows: [] }]]);
  multiplePaseo.registry.disconnect('paseo:beta', multiplePaseo.sessions.get('paseo:beta')!);
  assert.equal(await resolveOriginHost(multiplePaseo.registry, 'planner', multiplePaseo.lookup), undefined,
    'an offline second Paseo host still leaves the legacy identity ambiguous');
});

test('a bare legacy identity never resolves to a T3 host', async () => {
  const { registry, lookup } = fixture([['t3code:nightly', { knows: ['planner'] }]]);
  assert.equal(await resolveOriginHost(registry, 'planner', lookup), undefined);
});

test('an offline host that is not the claimant does not block a caller-named host', async () => {
  const { registry, lookup, sessions } = fixture([['paseo:alpha', { knows: ['planner'] }], ['t3code:nightly', { knows: [] }]]);
  registry.disconnect('t3code:nightly', sessions.get('t3code:nightly')!);
  assert.equal(await resolveOriginHost(registry, 'planner', lookup, paseoIdentity), 'paseo:alpha');
  // Evidence naming the offline host contradicts the claimant, so it decides nothing in its favour.
  assert.equal(await resolveOriginHost(registry, 'planner', lookup, { hostId: 't3code:nightly', source: 'caller identity source t3code' }), undefined);
  // Stale evidence about a host this registry never knew has no effect.
  assert.equal(await resolveOriginHost(registry, 'planner', lookup, { hostId: 'paseo:gone', source: 'stale' }), 'paseo:alpha');
});

test('caller evidence never lets a second claimant or a wrong host through', async () => {
  const both = fixture([['paseo:alpha', { knows: ['planner'] }], ['paseo:beta', { knows: ['planner'] }]]);
  assert.equal(await resolveOriginHost(both.registry, 'planner', both.lookup, paseoIdentity), undefined);
  const undecided = fixture([['paseo:alpha', { knows: ['other'] }], ['paseo:beta', { knows: ['planner'] }]]);
  assert.equal(await resolveOriginHost(undecided.registry, 'planner', undecided.lookup, paseoIdentity), undefined);
});

test('evidence matches the same thread in bare and qualified form, never a different host or thread', async () => {
  const known = ['paseo:alpha', 't3code:nightly'];
  const qualified = formatAgentId('paseo:alpha', 'planner');
  // A bare recorded author is Paseo's; the qualified caller of the same native thread matches it.
  assert.deepEqual(identitySourceHostEvidence('planner', { agent: qualified, hostId: 'paseo:alpha' }, known),
    { hostId: 'paseo:alpha', source: 'caller identity source' });
  assert.deepEqual(identitySourceHostEvidence(qualified, { agent: 'planner', hostId: 'paseo:alpha' }, known),
    { hostId: 'paseo:alpha', source: 'caller identity source' });
  assert.deepEqual(identitySourceHostEvidence(qualified, { agent: qualified, hostId: 'paseo:alpha' }, known),
    { hostId: 'paseo:alpha', source: 'caller identity source' });
  // A different native thread on the same host is not the author.
  assert.equal(identitySourceHostEvidence('planner-two', { agent: qualified, hostId: 'paseo:alpha' }, known), undefined);
  // A bare ID is Paseo's: a T3-qualified caller with the same native ID is a different thread.
  assert.equal(identitySourceHostEvidence('planner', { agent: formatAgentId('t3code:nightly', 'planner'), hostId: 't3code:nightly' }, known), undefined);
  // The same native thread on another host is a different identity.
  assert.equal(identitySourceHostEvidence(qualified, { agent: formatAgentId('t3code:nightly', 'planner'), hostId: 't3code:nightly' }, known), undefined);
  // A qualification that disagrees with the source's own host proves nothing.
  assert.equal(identitySourceHostEvidence('planner', { agent: qualified, hostId: 't3code:nightly' }, known), undefined);
  // Evidence for a host this registry never knew decides nothing, and no source is no evidence.
  assert.equal(identitySourceHostEvidence('planner', { agent: formatAgentId('paseo:gone', 'planner'), hostId: 'paseo:gone' }, known), undefined);
  assert.equal(identitySourceHostEvidence('planner', undefined, known), undefined);
  // A malformed qualified identity is no evidence rather than a thrown refusal.
  assert.equal(identitySourceHostEvidence('planner', { agent: 'nucleus-agent:v1:[', hostId: 'paseo:alpha' }, known), undefined);
});

test('a bare recorded origin resolves on Paseo with or without caller evidence while T3 is offline', async () => {
  const { registry, lookup, sessions } = fixture([['paseo:alpha', { knows: ['planner'] }], ['t3code:nightly', { knows: [] }]]);
  registry.disconnect('t3code:nightly', sessions.get('t3code:nightly')!);
  const qualified = formatAgentId('paseo:alpha', 'planner');
  const evidence = identitySourceHostEvidence('planner', { agent: qualified, hostId: 'paseo:alpha' }, registry.known().map(entry => entry.id));
  assert.equal(await resolveOriginHost(registry, 'planner', lookup, evidence), 'paseo:alpha');
  assert.equal(await resolveOriginHost(registry, 'planner', lookup), 'paseo:alpha');
});
