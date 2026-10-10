import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fixturePath = new URL('./fixtures/peer_message.fixture.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const priorityFixturePath = new URL('./fixtures/peer_message.priority.fixture.json', import.meta.url);
const priorityFixture = JSON.parse(readFileSync(priorityFixturePath, 'utf8'));

const EVENT_KEYS = ['convo_id', 'payload', 'sender', 'seq', 'ts', 'type'];
const PAYLOAD_KEYS = ['body', 'from_convo', 'from_kind', 'from_name'];
const PRIORITY_PAYLOAD_KEYS = ['body', 'from_convo', 'from_kind', 'from_name', 'priority'];

function keys(value) {
  return Object.keys(value).sort();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(keys(value).map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function fixtureVersion(event) {
  const shape = JSON.stringify(canonical(event));
  return `sha256:${createHash('sha256').update(shape).digest('hex')}`;
}

describe('peer_message wire fixture', () => {
  it('matches the exact event shape consumed by the bridge', () => {
    expect(keys(fixture)).toEqual(['event', 'fixtureVersion']);
    expect(keys(fixture.event)).toEqual(EVENT_KEYS);
    expect(keys(fixture.event.payload)).toEqual(PAYLOAD_KEYS);
    expect(fixture.event.type).toBe('peer_message');
    expect(fixture.fixtureVersion).toBe(fixtureVersion(fixture.event));

    expect(Number.isInteger(fixture.event.seq)).toBe(true);
    expect(typeof fixture.event.convo_id).toBe('string');
    expect(typeof fixture.event.ts).toBe('number');
    expect(typeof fixture.event.sender).toBe('string');
    for (const key of PAYLOAD_KEYS) {
      expect(typeof fixture.event.payload[key]).toBe('string');
    }

    expect(JSON.stringify(fixture)).not.toContain('idem_key');
  });

  it('matches the exact PRIORITY variant shape (5-key payload) the bridge receives', () => {
    // The bridge vendors this file byte-for-byte from the journal (producer-owned). A priority
    // peer message adds exactly one payload key, priority:true, which the terminal-injection
    // path (journalOnPeerMessage / formatPeerDelivery) reads to mark the line.
    expect(keys(priorityFixture)).toEqual(['event', 'fixtureVersion']);
    expect(keys(priorityFixture.event)).toEqual(EVENT_KEYS);
    expect(keys(priorityFixture.event.payload)).toEqual(PRIORITY_PAYLOAD_KEYS);
    expect(priorityFixture.event.payload.priority).toBe(true);
    expect(priorityFixture.event.type).toBe('peer_message');
    expect(priorityFixture.fixtureVersion).toBe(fixtureVersion(priorityFixture.event));
    expect(JSON.stringify(priorityFixture)).not.toContain('idem_key');
  });
});
