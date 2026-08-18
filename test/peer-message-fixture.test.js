import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fixturePath = new URL('./fixtures/peer_message.fixture.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const EVENT_KEYS = ['convo_id', 'payload', 'sender', 'seq', 'ts', 'type'];
const PAYLOAD_KEYS = ['body', 'from_convo', 'from_kind', 'from_name'];

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
});
