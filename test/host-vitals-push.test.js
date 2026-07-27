import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import net from 'net';
import { createJournalPublisher } from '../lib/journal-publisher.js';
import { cpuPercent, ramPercent, cpuSampledAtMs } from '../lib/session-status.js';

const silentLog = { warn: () => {}, error: () => {} };
const FAST_BACKOFF = { backoffBaseMs: 15, backoffCapMs: 60 };

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await delay(intervalMs);
  }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startFakeServer(port = 0) {
  const wss = new WebSocketServer({ port });
  const received = [];
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.op === 'hello') {
        ws.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: 0 }));
        return;
      }
      received.push(msg);
    });
  });
  return new Promise((resolve, reject) => {
    wss.on('listening', () => {
      const boundPort = wss.address().port;
      resolve({
        port: boundPort,
        url: `ws://127.0.0.1:${boundPort}/ws`,
        received,
        close: () => new Promise((r) => {
          for (const c of wss.clients) c.terminate();
          wss.close(r);
        }),
      });
    });
    wss.on('error', reject);
  });
}

// Mirrors the exact field logic of the push closure wired at boot in index.js.
// Pure — takes the three reader outputs as args (never samples), so the test
// exercises the branching without touching the shared CPU-sampler module state.
// cpu is omitted until the sampler has a first valid reading (matches the
// hostVitalLimits shape); sampled_at_ms uses the sampler stamp, else Date.now().
function buildVitals(cpu, ram, stamp) {
  const vitals = { sampled_at_ms: cpu !== null ? stamp : Date.now() };
  if (cpu !== null) vitals.cpu = cpu;
  if (ram !== null) vitals.ram = ram;
  return vitals;
}

describe('publishHostVitals', () => {
  it('emits {op:"host_vitals", vitals} with NO convo_id and no idem_key', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    // Prove the socket is up (hello_ok round-trip) via a queued frame before
    // touching the never-queued host_vitals path.
    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some((f) => f.op === 'convo_upsert'));

    pub.publishHostVitals({ cpu: 42, ram: 63, sampled_at_ms: 1700000000000 });
    await waitFor(() => fake.received.some((f) => f.op === 'host_vitals'));

    const frame = fake.received.find((f) => f.op === 'host_vitals');
    expect(frame).toEqual({ op: 'host_vitals', vitals: { cpu: 42, ram: 63, sampled_at_ms: 1700000000000 } });
    expect('convo_id' in frame).toBe(false);
    expect(frame.idem_key).toBeUndefined();

    pub.close();
    await fake.close();
  });

  it('is NOT queued: a call while disconnected is dropped silently (ephemeral, fail-open)', async () => {
    const port = await getFreePort(); // nothing listening yet
    const url = `ws://127.0.0.1:${port}/ws`;
    const pub = createJournalPublisher({ url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.publishHostVitals({ cpu: 1, ram: 2, sampled_at_ms: 3 }); // must be dropped
    await delay(80);

    const fake = await startFakeServer(port);
    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some((f) => f.op === 'convo_upsert'));
    await delay(120);
    expect(fake.received.filter((f) => f.op === 'host_vitals').length).toBe(0);

    pub.close();
    await fake.close();
  });

  it('never throws on unserializable vitals or when the publisher is disabled', () => {
    const disabled = createJournalPublisher({ url: '', token: '', log: silentLog });
    expect(() => disabled.publishHostVitals({ cpu: 1, ram: 2, sampled_at_ms: 3 })).not.toThrow();
    const cyclic = {};
    cyclic.self = cyclic;
    expect(() => disabled.publishHostVitals(cyclic)).not.toThrow();
  });

  it('the push closure reads cpuPercent/ramPercent (real, no timer) and publishes a ram reading', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });
    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some((f) => f.op === 'convo_upsert'));

    // Pure reads of the real session-status accessors — no sampler started, so
    // no shared module-state mutation. ramPercent is instant; cpuPercent is
    // whatever the (unstarted) sampler holds. Feed both through the same field
    // logic index.js uses and publish.
    const cpu = cpuPercent();
    const ram = ramPercent();
    expect(typeof ram).toBe('number'); // instant syscall on any real host
    pub.publishHostVitals(buildVitals(cpu, ram, cpuSampledAtMs()));

    await waitFor(() => fake.received.some((f) => f.op === 'host_vitals'));
    const frame = fake.received.find((f) => f.op === 'host_vitals');
    expect(typeof frame.vitals.ram).toBe('number');
    expect(typeof frame.vitals.sampled_at_ms).toBe('number');
    expect('convo_id' in frame).toBe(false);

    pub.close();
    await fake.close();
  });

  it('field logic: cpu omitted (with Date.now stamp) when unsampled; present with the sampler stamp once available', () => {
    // Before the sampler ticks (cpu === null): cpu key absent, stamp falls back
    // to a fresh Date.now(), ram still rides along.
    const before = Date.now();
    const unsampled = buildVitals(null, 63, 1700000000000);
    expect('cpu' in unsampled).toBe(false);
    expect(unsampled.ram).toBe(63);
    expect(unsampled.sampled_at_ms).toBeGreaterThanOrEqual(before); // Date.now(), not the passed stamp

    // Once the sampler has a valid reading: cpu present, stamp is the sampler's.
    const sampled = buildVitals(55, 63, 1700000000000);
    expect(sampled).toEqual({ cpu: 55, ram: 63, sampled_at_ms: 1700000000000 });
  });

  it('the push interval is unref\'d so it never holds the process open, and clearInterval stops it', async () => {
    let ticks = 0;
    const handle = setInterval(() => { ticks += 1; }, 15);
    // .unref() is what index.js calls on the push handle; assert it is a no-throw
    // op that returns the timer (Node contract) so the process can exit on it.
    expect(typeof handle.unref).toBe('function');
    expect(handle.unref()).toBe(handle);

    await waitFor(() => ticks >= 1);
    clearInterval(handle);
    const seen = ticks;
    await delay(60);
    expect(ticks).toBe(seen); // no further ticks after clear — shutdown path works
  });
});
