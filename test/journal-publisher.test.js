import { describe, it, expect } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import net from 'net';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createJournalPublisher } from '../lib/journal-publisher.js';

// Quiet logger for tests that don't care about warnings.
const silentLog = { warn: () => {}, error: () => {} };

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
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

// Minimal in-process fake journal server: accepts `hello`, replies `hello_ok`,
// and records every other frame it receives (in arrival order). `onFrame`,
// when given, is called with each non-hello frame and may return a reply
// frame to send back (e.g. a control error frame), or a falsy value to send
// nothing — used to simulate a server that rejects an op (e.g. read_marker
// from an agent connection) after having already accepted the socket.
function startFakeServer({ onHello, onFrame } = {}, port = 0) {
  const wss = new WebSocketServer({ port });
  const received = [];
  const connections = [];
  wss.on('connection', (ws) => {
    const conn = { ws, frames: [], helloCursor: undefined };
    connections.push(conn);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.op === 'hello') {
        conn.helloCursor = msg.cursor ?? null;
        const reply = (onHello && onHello(msg, conn, connections.length - 1)) || { seq: 0 };
        ws.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: reply.seq ?? 0 }));
        return;
      }
      conn.frames.push(msg);
      received.push(msg);
      if (onFrame) {
        const reply = onFrame(msg, conn);
        if (reply) ws.send(JSON.stringify(reply));
      }
    });
  });
  return new Promise((resolve, reject) => {
    wss.on('listening', () => {
      const boundPort = wss.address().port;
      resolve({
        port: boundPort,
        url: `ws://127.0.0.1:${boundPort}/ws`,
        received,
        connections,
        close: () => new Promise((r) => {
          for (const c of wss.clients) c.terminate();
          wss.close(r);
        }),
      });
    });
    wss.on('error', reject);
  });
}

// Minimal in-process fake HTTP server for uploadMedia tests. Records every
// request (method, url, headers, raw body bytes) and replies with whatever
// `handler` returns, or a default 200 media-upload response if omitted.
function startFakeHttpServer(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      received.push(entry);
      if (handler) {
        handler(entry, res);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          media_id: 'fake-media-id',
          size: body.length,
          content_type: req.headers['content-type'] || 'application/octet-stream',
          sha256: 'fakesha256',
        }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        received,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

const FAST_BACKOFF = { backoffBaseMs: 15, backoffCapMs: 60 };

describe('createJournalPublisher', () => {
  it('handshake then publish: convo_upsert precedes the first publish', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('convo-1', { title: 'Room A', sessionState: 'running' });
    pub.publishText('convo-1', { body: 'hi', from: 'user' });

    await waitFor(() => fake.received.length >= 2);

    expect(fake.received[0]).toMatchObject({
      op: 'convo_upsert', convo_id: 'convo-1', title: 'Room A', session_state: 'running',
    });
    expect(fake.received[0].idem_key).toBeUndefined();

    expect(fake.received[1]).toMatchObject({
      op: 'publish', convo_id: 'convo-1', type: 'text', payload: { body: 'hi', from: 'user' },
    });
    expect(typeof fake.received[1].idem_key).toBe('string');
    expect(fake.received[1].idem_key.length).toBeGreaterThan(0);

    pub.close();
    await fake.close();
  });

  it('covers publishPrompt and publishToolOutput with the right types', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('convo-2', {});
    pub.publishPrompt('convo-2', { question: 'Continue?', options: ['yes', 'no'], mode: 'pick_one' });
    pub.publishToolOutput('convo-2', { tool_use_id: 't1', command: 'ls -la', viewer_url: 'https://x', expires_at: 123 });
    pub.publishDiff('convo-2', {
      file_path: '/w/a.swift', display_path: 'a.swift', viewer_url: null,
      tool: 'Edit', label: null, diff: '@@ -1,1 +1,1 @@\n-a\n+b',
      added: 1, removed: 1, truncated: false, new_file: false,
    });

    await waitFor(() => fake.received.filter(f => f.op === 'publish').length >= 3);
    const [prompt, toolOutput] = fake.received.filter(f => f.op === 'publish');
    expect(prompt.type).toBe('prompt');
    expect(prompt.payload).toEqual({ question: 'Continue?', options: ['yes', 'no'], mode: 'pick_one' });
    expect(toolOutput.type).toBe('tool_output');
    expect(toolOutput.payload).toEqual({ tool_use_id: 't1', command: 'ls -la', viewer_url: 'https://x', expires_at: 123 });
    const diffFrame = fake.received.find(f => f.op === 'publish' && f.type === 'diff');
    expect(diffFrame).toMatchObject({
      convo_id: 'convo-2', type: 'diff',
      payload: { tool: 'Edit', added: 1, removed: 1, new_file: false },
    });
    expect(typeof diffFrame.idem_key).toBe('string');

    pub.close();
    await fake.close();
  });

  it('flushes frames enqueued while disconnected, in FIFO order, after hello_ok', async () => {
    const port = await getFreePort(); // nothing listening yet
    const url = `ws://127.0.0.1:${port}/ws`;
    const pub = createJournalPublisher({ url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    // Enqueued while the socket can't even connect.
    pub.upsertConvo('c1', { title: 'A' });
    pub.publishText('c1', { body: 'one', from: 'user' });
    pub.publishText('c1', { body: 'two', from: 'assistant' });
    pub.publishText('c1', { body: 'three', from: 'user' });

    await delay(80); // let a couple of failed connection attempts happen

    const fake = await startFakeServer({}, port);
    await waitFor(() => fake.received.length >= 4);

    expect(fake.received.map(f => f.op)).toEqual(['convo_upsert', 'publish', 'publish', 'publish']);
    expect(fake.received.slice(1).map(f => f.payload.body)).toEqual(['one', 'two', 'three']);

    pub.close();
    await fake.close();
  });

  it('reconnects after a mid-stream drop and resends unconfirmed frames with the same idem_key', async () => {
    // A real network drop makes it a coin flip whether ws.send's local callback
    // fires (i.e. the frame becomes "confirmed" and leaves the queue) before the
    // remote actually goes away — that race would make this test flaky either
    // way. So we control the drop precisely at the transport boundary: a
    // WebSocket subclass whose first instance forwards frames onto the real
    // wire (so the fake server genuinely sees them — this is a mid-stream drop,
    // not a pre-send failure) but deliberately never confirms the send callback
    // before killing the connection. Every later instance (i.e. the reconnect)
    // behaves like a normal WebSocket.
    let firstInstanceUsed = false;
    class DropFirstConfirmWebSocket extends WebSocket {
      constructor(...args) {
        super(...args);
        this._isFirst = !firstInstanceUsed;
        firstInstanceUsed = true;
      }
      send(data, cb) {
        if (!this._isFirst) return super.send(data, cb);
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = null; }
        if (!parsed || parsed.op !== 'publish') return super.send(data, cb);
        // Put the bytes on the wire for real, but never confirm locally, then
        // tear the connection down shortly after — an unconfirmed mid-stream drop.
        super.send(data);
        setTimeout(() => {
          try { cb(new Error('simulated drop')); } catch { /* test-only */ }
          try { this.terminate(); } catch { /* already going down */ }
        }, 10);
      }
    }

    const fake = await startFakeServer();
    const pub = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF,
      WebSocketImpl: DropFirstConfirmWebSocket,
    });

    pub.upsertConvo('c1', { title: 'A' });
    pub.publishText('c1', { body: 'one', from: 'user' });
    pub.publishText('c1', { body: 'two', from: 'user' });
    pub.publishText('c1', { body: 'three', from: 'user' });

    await waitFor(() => fake.connections.length >= 2
      && fake.connections[1].frames.filter(f => f.op === 'publish').length >= 3, 4000);

    pub.close();
    await fake.close();

    // Connection 1 (the doomed one) really did carry the frames on the wire —
    // sanity check that this was a mid-stream drop, not a pre-send failure.
    const conn1ByBody = new Map(
      fake.connections[0].frames.filter(f => f.op === 'publish').map(f => [f.payload.body, f.idem_key])
    );
    expect(conn1ByBody.size).toBeGreaterThan(0);

    // Connection 2 (the reconnect) received the full set again, in order.
    const conn2Publishes = fake.connections[1].frames.filter(f => f.op === 'publish');
    expect(conn2Publishes.map(f => f.payload.body)).toEqual(['one', 'two', 'three']);

    // Every frame observed on BOTH connections carries the identical idem_key —
    // proof the key is assigned once at enqueue time, not regenerated on resend.
    for (const f of conn2Publishes) {
      if (conn1ByBody.has(f.payload.body)) {
        expect(f.idem_key).toBe(conn1ByBody.get(f.payload.body));
      }
    }
  });

  it('keepalive: terminates and reconnects when pings go unanswered (half-open socket)', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF,
      keepaliveIntervalMs: 50,
    });
    await waitFor(() => fake.connections.length === 1);

    // Simulate a half-open connection: the server stops reading its socket,
    // so the client's protocol-level pings are never answered — exactly the
    // NAT/proxy silent-drop failure mode. The TCP connection itself stays
    // "ESTABLISHED" from the client's point of view.
    fake.connections[0].ws._socket.pause();

    // The keepalive must notice the missing pong and tear the socket down,
    // and the normal reconnect path must then produce a second connection.
    await waitFor(() => fake.connections.length >= 2, 4000);

    pub.close();
    await fake.close();
  });

  it('keepalive: a healthy idle connection is left alone and stays usable', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF,
      keepaliveIntervalMs: 40,
    });
    await waitFor(() => fake.connections.length === 1);

    // Sit idle across many keepalive intervals — the ws server answers pings
    // with pongs automatically, so no reconnect may happen.
    await delay(300);
    expect(fake.connections.length).toBe(1);

    // And the connection is still genuinely usable afterwards.
    pub.publishText('c1', { body: 'still here', from: 'user' });
    await waitFor(() => fake.received.some(f => f.op === 'publish' && f.payload?.body === 'still here'));

    pub.close();
    await fake.close();
  });

  it('bounds the queue: drops the oldest frame on overflow and warns once per episode', async () => {
    const port = await getFreePort(); // stays disconnected for the whole enqueue burst
    const url = `ws://127.0.0.1:${port}/ws`;
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({ url, token: 'tok', log, queueLimit: 5, ...FAST_BACKOFF });

    for (let i = 0; i < 12; i++) pub.publishText('c1', { body: `m${i}`, from: 'user' });

    const fake = await startFakeServer({}, port);
    await waitFor(() => fake.received.length >= 5);
    await delay(100); // confirm nothing extra trickles in beyond the surviving 5

    expect(fake.received.length).toBe(5);
    expect(fake.received.map(f => f.payload.body)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11']);
    expect(warnings.filter(w => /overflow/i.test(w)).length).toBe(1);

    pub.close();
    await fake.close();
  });

  it('disabled mode (no url/token): every method is a safe no-op, nothing throws', async () => {
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({ url: '', token: '', log });

    expect(() => {
      pub.upsertConvo('c1', { title: 'x', sessionState: 'running' });
      pub.publishText('c1', { body: 'hi', from: 'user' });
      pub.publishPrompt('c1', { question: 'q?', options: [] });
      pub.publishToolOutput('c1', { command: 'ls' });
      pub.publishDiff('c1', { diff: 'x' });
      pub.publishFile('c1', { blob_ref: 'm1', content_type: 'application/pdf', name: 'doc.pdf', size: 1, from: 'user' });
      pub.publishImage('c1', { blob_ref: 'm2', content_type: 'image/png', name: 'pic.png', size: 1, from: 'user' });
      pub.publishActivity('c1', 'thinking');
      pub.publishStatus('c1', { model: 'x' });
      pub.markRead('c1');
      pub.close();
      pub.close(); // idempotent
    }).not.toThrow();

    const uploadResult = await pub.uploadMedia({ bytes: Buffer.from('x'), contentType: 'text/plain', name: 'f.txt' });
    expect(uploadResult == null).toBe(true);

    expect(warnings.length).toBe(1);
  });

  it('upsertConvo forwards parentConvoId as parent_convo_id (child sub-chats), and omits it when absent', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    // Child upsert: parent_convo_id rides alongside title + session_state.
    pub.upsertConvo('parent:sub:agent-1', {
      title: 'code-explorer',
      sessionState: 'running',
      parentConvoId: 'parent',
    });
    // A plain (non-child) upsert must NOT carry a parent_convo_id key at all.
    pub.upsertConvo('plain', { title: 'Room A' });

    await waitFor(() => fake.received.filter(f => f.op === 'convo_upsert').length >= 2);
    const [child, plain] = fake.received.filter(f => f.op === 'convo_upsert');
    expect(child).toMatchObject({
      op: 'convo_upsert', convo_id: 'parent:sub:agent-1',
      title: 'code-explorer', session_state: 'running', parent_convo_id: 'parent',
    });
    expect(plain).toMatchObject({ op: 'convo_upsert', convo_id: 'plain', title: 'Room A' });
    expect('parent_convo_id' in plain).toBe(false);

    pub.close();
    await fake.close();
  });

  it('upsertConvo never throws even for malformed opts (null, missing, non-object)', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    expect(() => {
      pub.upsertConvo('c1');
      pub.upsertConvo('c1', null);
      pub.upsertConvo('c1', undefined);
      pub.upsertConvo('c1', 'not-an-object');
      pub.upsertConvo('c1', { title: 'ok' });
    }).not.toThrow();

    await waitFor(() => fake.received.filter(f => f.op === 'convo_upsert').length >= 1);
    pub.close();
    await fake.close();
  });

  it('publishActivity: sends {op, convo_id, state, detail?} once connected, with no idem_key', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    // Prove the connection is really up (hello_ok received, pump ran) via a
    // queued frame before touching the never-queued publishActivity path.
    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some(f => f.op === 'convo_upsert'));

    pub.publishActivity('c1', 'thinking');
    pub.publishActivity('c1', 'tool', 'rake test:run');
    await waitFor(() => fake.received.filter(f => f.op === 'activity').length >= 2);

    const [f1, f2] = fake.received.filter(f => f.op === 'activity');
    expect(f1).toEqual({ op: 'activity', convo_id: 'c1', state: 'thinking' });
    expect(f2).toEqual({ op: 'activity', convo_id: 'c1', state: 'tool', detail: 'rake test:run' });

    pub.close();
    await fake.close();
  });

  it('publishStatus: sends {op, convo_id, status} once connected, with no idem_key', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some(f => f.op === 'convo_upsert'));

    const status = { model: 'claude-fable-5', context: { tokens: 253_412, window: 1_000_000, pct: 25 } };
    pub.publishStatus('c1', status);
    await waitFor(() => fake.received.some(f => f.op === 'status'));

    const frame = fake.received.find(f => f.op === 'status');
    expect(frame).toEqual({ op: 'status', convo_id: 'c1', status });

    pub.close();
    await fake.close();
  });

  it('publishStatus is NOT queued: a call while disconnected is dropped silently', async () => {
    const port = await getFreePort(); // nothing listening yet
    const url = `ws://127.0.0.1:${port}/ws`;
    const pub = createJournalPublisher({ url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.publishStatus('c1', { model: 'x' }); // must be dropped: no connection yet
    await delay(80);

    const fake = await startFakeServer({}, port);
    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some(f => f.op === 'convo_upsert'));
    await delay(150);
    expect(fake.received.filter(f => f.op === 'status').length).toBe(0);

    pub.close();
    await fake.close();
  });

  it('publishStatus never throws on unserializable status', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });
    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some(f => f.op === 'convo_upsert'));

    const cyclic = {};
    cyclic.self = cyclic;
    expect(() => pub.publishStatus('c1', cyclic)).not.toThrow();

    pub.close();
    await fake.close();
  });

  it('publishActivity is NOT queued: a call while disconnected is dropped, not replayed after a later reconnect', async () => {
    const port = await getFreePort(); // nothing listening yet
    const url = `ws://127.0.0.1:${port}/ws`;
    const pub = createJournalPublisher({ url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.publishActivity('c1', 'thinking'); // must be dropped: no connection yet
    await delay(80); // let a couple of failed connection attempts happen

    const fake = await startFakeServer({}, port);
    // Prove the connection did come up (hello_ok round-trip) via a queued
    // frame, then give a wrongly-replayed activity frame a full window to
    // show up before asserting its absence.
    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some(f => f.op === 'convo_upsert'));
    await delay(80);

    expect(fake.received.some(f => f.op === 'activity')).toBe(false);

    pub.close();
    await fake.close();
  });

  it('publishActivity is a safe no-op when disabled (no url/token) and never throws', () => {
    const pub = createJournalPublisher({ url: '', token: '', log: silentLog });
    expect(() => {
      pub.publishActivity('c1', 'thinking');
      pub.publishActivity('c1', 'tool', 'ls');
    }).not.toThrow();
  });

  it('stream: sends {op, convo_id, message_ref, replace_text} once connected, with no idem_key', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, streamIntervalMs: 40 });

    // Prove the socket is really up before touching the never-queued path.
    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some(f => f.op === 'convo_upsert'));

    pub.stream('c1', 'm1', 'Hello');
    await waitFor(() => fake.received.filter(f => f.op === 'stream').length >= 1);

    const f1 = fake.received.filter(f => f.op === 'stream')[0];
    expect(f1).toEqual({ op: 'stream', convo_id: 'c1', message_ref: 'm1', replace_text: 'Hello' });
    expect(f1.idem_key).toBeUndefined();
    expect(f1.text).toBeUndefined(); // never an incremental delta, always replace_text

    pub.close();
    await fake.close();
  });

  it('stream: coalesces a rapid burst to a leading + single trailing frame, latest text wins', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, streamIntervalMs: 60 });

    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some(f => f.op === 'convo_upsert'));

    // Firehose: leading 'A' goes out immediately; 'B','C','D' land inside the
    // window and collapse to one trailing frame carrying the latest ('D').
    pub.stream('c1', 'm1', 'A');
    pub.stream('c1', 'm1', 'B');
    pub.stream('c1', 'm1', 'C');
    pub.stream('c1', 'm1', 'D');

    await waitFor(() => fake.received.filter(f => f.op === 'stream').length >= 2);
    await delay(120); // well past the window — prove nothing extra trickles in

    const texts = fake.received.filter(f => f.op === 'stream').map(f => f.replace_text);
    expect(texts).toEqual(['A', 'D']);

    pub.close();
    await fake.close();
  });

  it('stream is NOT queued: a call while disconnected is dropped, not replayed after a later reconnect', async () => {
    const port = await getFreePort(); // nothing listening yet
    const url = `ws://127.0.0.1:${port}/ws`;
    const pub = createJournalPublisher({ url, token: 'tok', log: silentLog, ...FAST_BACKOFF, streamIntervalMs: 40 });

    pub.stream('c1', 'm1', 'lost'); // must be dropped: no connection yet
    await delay(80);

    const fake = await startFakeServer({}, port);
    pub.upsertConvo('c1', {}); // prove the reconnect handshake completed
    await waitFor(() => fake.received.some(f => f.op === 'convo_upsert'));
    await delay(80);

    expect(fake.received.some(f => f.op === 'stream')).toBe(false);

    pub.close();
    await fake.close();
  });

  it('endStream discards a pending coalesced frame so nothing stale lands after finalize', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, streamIntervalMs: 80 });

    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some(f => f.op === 'convo_upsert'));

    pub.stream('c1', 'm1', 'partial-A'); // leading -> sent now
    pub.stream('c1', 'm1', 'partial-B'); // coalesced -> pending trailing frame
    // Turn finalizes before the trailing timer fires: discard the pending frame.
    pub.endStream('c1', 'm1');

    await waitFor(() => fake.received.filter(f => f.op === 'stream').length >= 1);
    await delay(150); // longer than the window: a discarded frame must never appear

    const texts = fake.received.filter(f => f.op === 'stream').map(f => f.replace_text);
    expect(texts).toEqual(['partial-A']); // 'partial-B' was dropped by endStream

    pub.close();
    await fake.close();
  });

  it('endStream({clear:true}) emits one final empty replace_text to collapse a dangling overlay', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, streamIntervalMs: 40 });

    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some(f => f.op === 'convo_upsert'));

    pub.stream('c1', 'm1', 'in progress…');
    await waitFor(() => fake.received.filter(f => f.op === 'stream').length >= 1);

    pub.endStream('c1', 'm1', { clear: true });
    await waitFor(() => fake.received.filter(f => f.op === 'stream' && f.replace_text === '').length >= 1);

    const cleared = fake.received.filter(f => f.op === 'stream' && f.replace_text === '');
    expect(cleared.length).toBe(1);
    expect(cleared[0]).toEqual({ op: 'stream', convo_id: 'c1', message_ref: 'm1', replace_text: '' });

    pub.close();
    await fake.close();
  });

  it('stream/endStream are safe no-ops when disabled (no url/token) and never throw', () => {
    const pub = createJournalPublisher({ url: '', token: '', log: silentLog });
    expect(() => {
      pub.stream('c1', 'm1', 'x');
      pub.endStream('c1', 'm1');
      pub.endStream('c1', 'm1', { clear: true });
    }).not.toThrow();
  });

  it('publishActivity: an error frame from an older server without the op flows through the existing per-code warn, not a separate mechanism', async () => {
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const fake = await startFakeServer({
      onFrame: (msg) => (msg.op === 'activity' ? { kind: 'control', op: 'error', code: 'bad_request', ref: 'activity' } : null),
    });
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log, ...FAST_BACKOFF });

    pub.upsertConvo('c1', {});
    await waitFor(() => fake.received.some(f => f.op === 'convo_upsert'));

    pub.publishActivity('c1', 'thinking');
    pub.publishActivity('c1', 'tool', 'ls');
    pub.publishActivity('c1', 'idle');
    await waitFor(() => fake.received.filter(f => f.op === 'activity').length >= 3);
    await delay(80); // let the rejected error frames round-trip back

    // Exactly one warning for the repeated 'bad_request' code across three
    // rejected activity sends — the shared per-connection-epoch dedup
    // (warnedErrorCodes), not a second per-method mechanism.
    const badRequestWarnings = warnings.filter(w => /bad_request/.test(w));
    expect(badRequestWarnings.length).toBe(1);

    // Nothing wedged: a normal (queued) publish made afterward still lands.
    pub.publishText('c1', { body: 'still alive', from: 'user' });
    await waitFor(() => fake.received.some(f => f.op === 'publish'));

    pub.close();
    await fake.close();
  });

  it('disabled mode when only the token is missing', () => {
    const log = { warn: () => {}, error: () => {} };
    expect(() => {
      const pub = createJournalPublisher({ url: 'ws://127.0.0.1:1/ws', token: '', log });
      pub.publishText('c1', { body: 'hi', from: 'user' });
      pub.close();
    }).not.toThrow();
  });

  it('never assigns an idem_key with the fin: prefix reserved by finalize', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('c1', {});
    for (let i = 0; i < 25; i++) pub.publishText('c1', { body: `m${i}`, from: 'user' });

    await waitFor(() => fake.received.filter(f => f.op === 'publish').length >= 25);
    const idemKeys = fake.received.filter(f => f.op === 'publish').map(f => f.idem_key);
    expect(idemKeys.length).toBe(25);
    expect(new Set(idemKeys).size).toBe(25); // all unique
    for (const k of idemKeys) {
      expect(k.startsWith('fin:')).toBe(false);
      expect(k).toMatch(/^[0-9a-f-]{36}$/i);
    }

    pub.close();
    await fake.close();
  });

  it('sends the hello frame with cursor:null (live-only, no replay)', async () => {
    let helloMsg = null;
    const fake = await startFakeServer({ onHello: (msg) => { helloMsg = msg; return { seq: 0 }; } });
    const pub = createJournalPublisher({ url: fake.url, token: 'secret-tok', log: silentLog, ...FAST_BACKOFF });
    pub.publishText('c1', { body: 'x', from: 'user' });
    await waitFor(() => helloMsg !== null);
    expect(helloMsg).toMatchObject({ op: 'hello', token: 'secret-tok', cursor: null });
    pub.close();
    await fake.close();
  });

  it('publishFile and publishImage send the right publish type, with payload passthrough and idem keys', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('convo-3', {});
    pub.publishFile('convo-3', { blob_ref: 'm1', content_type: 'application/pdf', name: 'doc.pdf', size: 42, from: 'user' });
    pub.publishImage('convo-3', { blob_ref: 'm2', content_type: 'image/png', name: 'pic.png', size: 99, from: 'assistant', dims: { w: 10, h: 20 } });

    await waitFor(() => fake.received.filter(f => f.op === 'publish').length >= 2);
    const [file, image] = fake.received.filter(f => f.op === 'publish');

    expect(file.type).toBe('file');
    expect(file.payload).toEqual({ blob_ref: 'm1', content_type: 'application/pdf', name: 'doc.pdf', size: 42, from: 'user' });
    expect(typeof file.idem_key).toBe('string');

    expect(image.type).toBe('image');
    expect(image.payload).toEqual({ blob_ref: 'm2', content_type: 'image/png', name: 'pic.png', size: 99, from: 'assistant', dims: { w: 10, h: 20 } });
    expect(typeof image.idem_key).toBe('string');

    pub.close();
    await fake.close();
  });

  it('markRead enqueues a read_marker frame with no idem_key, FIFO right after the preceding publish', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('convo-4', {});
    pub.publishText('convo-4', { body: 'hi', from: 'user' });
    pub.markRead('convo-4');

    await waitFor(() => fake.received.length >= 3);
    expect(fake.received.map(f => f.op)).toEqual(['convo_upsert', 'publish', 'read_marker']);

    const marker = fake.received[2];
    expect(marker).toEqual({ op: 'read_marker', convo_id: 'convo-4', up_to_seq: null });
    expect(marker.idem_key).toBeUndefined();

    pub.close();
    await fake.close();
  });

  it('markRead is re-sent after a reconnect, same as any other frame', async () => {
    const port = await getFreePort(); // nothing listening yet
    const url = `ws://127.0.0.1:${port}/ws`;
    const pub = createJournalPublisher({ url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('c1', { title: 'A' });
    pub.markRead('c1');

    await delay(80); // let a couple of failed connection attempts happen

    const fake = await startFakeServer({}, port);
    await waitFor(() => fake.received.length >= 2);

    expect(fake.received.map(f => f.op)).toEqual(['convo_upsert', 'read_marker']);

    pub.close();
    await fake.close();
  });

  it('an error frame from the server (e.g. forbidden for read_marker against an old server) is logged once per code and never wedges the queue', async () => {
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    // Simulates today's matron-journal, which rejects agent read_marker with
    // a 'forbidden' control error frame — every single time, since it isn't
    // stateful. The publisher calls markRead after every user-mirrored
    // publish, so without per-code dedup this would warn once per user
    // message forever.
    const fake = await startFakeServer({
      onFrame: (msg) => (msg.op === 'read_marker' ? { kind: 'control', op: 'error', code: 'forbidden', ref: 'read_marker' } : null),
    });
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log, ...FAST_BACKOFF });

    pub.upsertConvo('c1', {});
    pub.publishText('c1', { body: 'one', from: 'user' });
    pub.markRead('c1');
    pub.publishText('c1', { body: 'two', from: 'user' });
    pub.markRead('c1');
    pub.publishText('c1', { body: 'three', from: 'user' });
    pub.markRead('c1');

    await waitFor(() => fake.received.filter(f => f.op === 'publish').length >= 3);
    await delay(80); // let the rejected read_marker error frames round-trip back

    // Every publish still flowed despite every read_marker being rejected —
    // the queue never wedged.
    expect(fake.received.filter(f => f.op === 'publish').map(f => f.payload.body)).toEqual(['one', 'two', 'three']);
    expect(fake.received.filter(f => f.op === 'read_marker').length).toBe(3);

    // Only one warning for the repeated 'forbidden' code, not one per frame.
    const forbiddenWarnings = warnings.filter(w => /forbidden/.test(w));
    expect(forbiddenWarnings.length).toBe(1);

    pub.close();
    await fake.close();
  });

  it('error-code dedup is per connection epoch: warns again after a reconnect, still deduped within each epoch', async () => {
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const fake = await startFakeServer({
      onFrame: (msg) => (msg.op === 'read_marker' ? { kind: 'control', op: 'error', code: 'forbidden', ref: 'read_marker' } : null),
    });
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log, ...FAST_BACKOFF });

    // Epoch 1: two rejected read_markers -> exactly one warning.
    pub.upsertConvo('c1', {});
    pub.markRead('c1');
    pub.markRead('c1');
    await waitFor(() => fake.received.filter(f => f.op === 'read_marker').length >= 2);
    await waitFor(() => warnings.filter(w => /forbidden/.test(w)).length >= 1);
    await delay(60); // let the second rejection's error frame round-trip too
    expect(warnings.filter(w => /forbidden/.test(w)).length).toBe(1);

    // Server drops the connection; the publisher reconnects (new epoch).
    fake.connections[0].ws.terminate();
    await waitFor(() => fake.connections.length >= 2, 4000);

    // Epoch 2: the same 'forbidden' code must be logged once more — a fresh
    // connection is a fresh observability window, so a later, unrelated
    // problem that happens to reuse a previously-seen code doesn't stay
    // permanently invisible. Still deduped within the epoch.
    pub.markRead('c1');
    pub.markRead('c1');
    await waitFor(() => warnings.filter(w => /forbidden/.test(w)).length >= 2, 4000);
    await delay(60); // let the fourth rejection's error frame round-trip too
    expect(warnings.filter(w => /forbidden/.test(w)).length).toBe(2);

    pub.close();
    await fake.close();
  });

  it('uploadMedia: happy path POSTs raw bytes to the derived HTTP base URL with Bearer auth and Content-Type', async () => {
    const httpServer = await startFakeHttpServer();
    // ws:// -> http://, strip trailing /ws, per the fixed contract.
    const wsUrl = `ws://127.0.0.1:${httpServer.port}/ws`;
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok-123', log: silentLog, ...FAST_BACKOFF });

    const bytes = Buffer.from('hello media bytes');
    const result = await pub.uploadMedia({ bytes, contentType: 'image/png', name: 'photo.png' });

    expect(result).toEqual({
      media_id: 'fake-media-id',
      size: bytes.length,
      content_type: 'image/png',
      sha256: 'fakesha256',
    });

    // The publisher's own WS connection attempt also lands on this HTTP
    // server (it's a plain http.createServer, so the WS upgrade request
    // just arrives as an ordinary GET /ws) — filter down to the actual
    // /media POST rather than asserting on every request this server saw.
    const mediaRequests = httpServer.received.filter(r => r.url === '/media');
    expect(mediaRequests.length).toBe(1);
    const req = mediaRequests[0];
    expect(req.method).toBe('POST');
    expect(req.headers['authorization']).toBe('Bearer tok-123');
    expect(req.headers['content-type']).toBe('image/png');
    expect(req.body.equals(bytes)).toBe(true);

    pub.close();
    await httpServer.close();
  });

  it('uploadMedia: a 2xx response missing a string media_id resolves null (not a blob_ref: undefined event), warns once', async () => {
    const httpServer = await startFakeHttpServer((_entry, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Malformed/unexpected success body — no media_id at all.
      res.end(JSON.stringify({ size: 3, content_type: 'text/plain', sha256: 'deadbeef' }));
    });
    const wsUrl = `ws://127.0.0.1:${httpServer.port}/ws`;
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok', log, ...FAST_BACKOFF });

    warnings.length = 0; // drop any reconnect-attempt warnings from the WS side
    const result = await pub.uploadMedia({ bytes: Buffer.from('abc'), contentType: 'text/plain', name: 'f.txt' });
    expect(result).toBeNull();

    const uploadWarnings = warnings.filter(w => /uploadMedia/.test(w));
    expect(uploadWarnings.length).toBe(1);

    pub.close();
    await httpServer.close();
  });

  it('uploadMedia: a media_id that is not a string (e.g. null, number) also resolves null', async () => {
    const httpServer = await startFakeHttpServer((_entry, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ media_id: 12345, size: 3 }));
    });
    const wsUrl = `ws://127.0.0.1:${httpServer.port}/ws`;
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    const result = await pub.uploadMedia({ bytes: Buffer.from('abc'), contentType: 'text/plain', name: 'f.txt' });
    expect(result).toBeNull();

    pub.close();
    await httpServer.close();
  });

  it('uploadMedia: a non-2xx HTTP response resolves null, never throws', async () => {
    const httpServer = await startFakeHttpServer((_entry, res) => {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'too_large' }));
    });
    const wsUrl = `ws://127.0.0.1:${httpServer.port}/ws`;
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    const result = await pub.uploadMedia({ bytes: Buffer.alloc(10), contentType: 'application/octet-stream', name: 'big.bin' });
    expect(result == null).toBe(true);

    pub.close();
    await httpServer.close();
  });

  it('uploadMedia: a network failure (nothing listening) resolves null, never throws, and warns exactly once', async () => {
    const port = await getFreePort(); // nothing listening
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok', log, ...FAST_BACKOFF });

    warnings.length = 0; // drop any reconnect-attempt warnings from the WS side
    const result = await pub.uploadMedia({ bytes: Buffer.from('x'), contentType: 'text/plain', name: 'f.txt' });
    expect(result == null).toBe(true);

    const uploadWarnings = warnings.filter(w => /uploadMedia/.test(w));
    expect(uploadWarnings.length).toBe(1);

    pub.close();
  });

  it('fetchMedia: happy path GETs the derived HTTP base URL with Bearer auth and returns {buffer, contentType}', async () => {
    const bytes = Buffer.from('fetched media bytes');
    const httpServer = await startFakeHttpServer((entry, res) => {
      if (entry.url === '/media/blob-77') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(bytes);
      } else {
        res.writeHead(404); res.end();
      }
    });
    const wsUrl = `ws://127.0.0.1:${httpServer.port}/ws`;
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok-xyz', log: silentLog, ...FAST_BACKOFF });

    const result = await pub.fetchMedia('blob-77');
    expect(result).not.toBeNull();
    expect(result.contentType).toBe('image/png');
    expect(result.buffer.equals(bytes)).toBe(true);

    const mediaReqs = httpServer.received.filter(r => r.url === '/media/blob-77');
    expect(mediaReqs.length).toBe(1);
    expect(mediaReqs[0].method).toBe('GET');
    expect(mediaReqs[0].headers['authorization']).toBe('Bearer tok-xyz');

    pub.close();
    await httpServer.close();
  });

  it('fetchMedia: a missing/blank blob_ref resolves null and warns, without any HTTP call', async () => {
    const httpServer = await startFakeHttpServer();
    const wsUrl = `ws://127.0.0.1:${httpServer.port}/ws`;
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok', log, ...FAST_BACKOFF });

    warnings.length = 0;
    expect(await pub.fetchMedia('')).toBeNull();
    expect(await pub.fetchMedia(null)).toBeNull();
    expect(httpServer.received.filter(r => r.url && r.url.startsWith('/media')).length).toBe(0);
    expect(warnings.some(w => /fetchMedia/.test(w))).toBe(true);

    pub.close();
    await httpServer.close();
  });

  it('fetchMedia: a non-2xx response resolves null, never throws', async () => {
    const httpServer = await startFakeHttpServer((_entry, res) => { res.writeHead(404); res.end(); });
    const wsUrl = `ws://127.0.0.1:${httpServer.port}/ws`;
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    expect(await pub.fetchMedia('nope')).toBeNull();

    pub.close();
    await httpServer.close();
  });

  it('fetchMedia: an over-cap blob (declared content-length beyond fetchMediaMaxBytes) is aborted and dropped, warns', async () => {
    const big = Buffer.alloc(64, 0x41); // 64 bytes, cap set to 8 below
    const httpServer = await startFakeHttpServer((_entry, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(big);
    });
    const wsUrl = `ws://127.0.0.1:${httpServer.port}/ws`;
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok', log, ...FAST_BACKOFF, fetchMediaMaxBytes: 8 });

    warnings.length = 0;
    const result = await pub.fetchMedia('big-blob');
    expect(result).toBeNull();
    expect(warnings.some(w => /exceeds 8 cap|aborted/.test(w))).toBe(true);

    pub.close();
    await httpServer.close();
  });

  it('fetchMedia: a network failure (nothing listening) resolves null, never throws, warns once', async () => {
    const port = await getFreePort();
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok', log, ...FAST_BACKOFF });

    warnings.length = 0;
    expect(await pub.fetchMedia('blob-1')).toBeNull();
    expect(warnings.filter(w => /fetchMedia/.test(w)).length).toBe(1);

    pub.close();
  });

  it('fetchMedia: a disabled (unconfigured) publisher returns null', () => {
    const pub = createJournalPublisher({ url: null, token: null, log: silentLog });
    expect(pub.fetchMedia('anything')).toBeNull();
  });
});

// Inbound journal-frame consumption (Matron -> bridge input) and cursor
// persistence. Loop-prevention (sender-based filtering) is deliberately NOT
// tested here — it lives in the index.js consumer (lib/journal-input-router.js),
// and this module must deliver every kind:'journal' frame — agent-sender
// echoes included — to onEvent, undiscriminated. See journal-input-router.test.js.
describe('createJournalPublisher — onEvent + cursor persistence', () => {
  const FAST_CURSOR = { cursorDebounceMs: 20 };

  function tmpCursorFile() {
    const dir = mkdtempSync(path.join(tmpdir(), 'journal-cursor-'));
    return path.join(dir, 'cursor.json');
  }

  function journalFrame(seq, overrides = {}) {
    return {
      kind: 'journal', seq, convo_id: 'c1', ts: Date.now(),
      sender: 'user:dan', type: 'text', payload: { body: `m${seq}` },
      ...overrides,
    };
  }

  it('delivers inbound journal frames to onEvent, including agent-sender echoes (filtering is index-level)', async () => {
    const fake = await startFakeServer();
    const delivered = [];
    const pub = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, ...FAST_CURSOR,
      onEvent: (frame) => delivered.push(frame),
    });

    await waitFor(() => fake.connections.length >= 1);
    fake.connections[0].ws.send(JSON.stringify(journalFrame(1, { sender: 'user:dan' })));
    fake.connections[0].ws.send(JSON.stringify(journalFrame(2, { sender: 'agent:dev-2' })));

    await waitFor(() => delivered.length >= 2);
    expect(delivered.map(f => f.sender)).toEqual(['user:dan', 'agent:dev-2']);
    expect(delivered.map(f => f.seq)).toEqual([1, 2]);

    pub.close();
    await fake.close();
  });

  it('without onEvent set, inbound journal frames are ignored (existing publish-only behavior)', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    await waitFor(() => fake.connections.length >= 1);
    // Must not throw even though nothing is listening for it.
    expect(() => fake.connections[0].ws.send(JSON.stringify(journalFrame(1)))).not.toThrow();
    await delay(50);

    pub.close();
    await fake.close();
  });

  it('persists the max seq seen to cursorFile, debounced', async () => {
    const fake = await startFakeServer();
    const cursorFile = tmpCursorFile();
    const pub = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, ...FAST_CURSOR,
      cursorFile, onEvent: () => {},
    });

    await waitFor(() => fake.connections.length >= 1);
    // Not written yet — debounce hasn't fired.
    expect(existsSync(cursorFile)).toBe(false);

    fake.connections[0].ws.send(JSON.stringify(journalFrame(5)));
    fake.connections[0].ws.send(JSON.stringify(journalFrame(3))); // out of order — max must stick at 5
    await waitFor(() => existsSync(cursorFile));
    await waitFor(() => JSON.parse(readFileSync(cursorFile, 'utf-8')).cursor === 5);

    pub.close();
    await fake.close();
  });

  it('no cursor file yet -> first hello carries cursor:null (live-only, never replays as input)', async () => {
    let helloMsg = null;
    const fake = await startFakeServer({ onHello: (msg) => { helloMsg = msg; return { seq: 0 }; } });
    const cursorFile = tmpCursorFile(); // file does not exist
    const pub = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, ...FAST_CURSOR,
      cursorFile, onEvent: () => {},
    });

    await waitFor(() => helloMsg !== null);
    expect(helloMsg.cursor).toBeNull();

    pub.close();
    await fake.close();
  });

  it('reconnect hello carries the persisted cursor', async () => {
    const fake = await startFakeServer();
    const cursorFile = tmpCursorFile();
    const pub = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, ...FAST_CURSOR,
      cursorFile, onEvent: () => {},
    });

    await waitFor(() => fake.connections.length >= 1);
    fake.connections[0].ws.send(JSON.stringify(journalFrame(7)));
    await waitFor(() => existsSync(cursorFile) && JSON.parse(readFileSync(cursorFile, 'utf-8')).cursor === 7);

    // Force a reconnect.
    fake.connections[0].ws.terminate();
    // Wait for the reconnect's hello to be RECEIVED, not just the socket
    // accepted: helloCursor stays `undefined` until the fake server parses the
    // hello frame, so a bare connections.length>=2 wait races the hello and
    // reads the initial undefined.
    await waitFor(() => fake.connections.length >= 2
      && fake.connections[1].helloCursor !== undefined, 4000);

    expect(fake.connections[1].helloCursor).toBe(7);

    pub.close();
    await fake.close();
  });

  it('a fresh publisher pointed at an existing cursor file resumes from it (bridge restart)', async () => {
    const fake = await startFakeServer();
    const cursorFile = tmpCursorFile();
    const pub1 = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, ...FAST_CURSOR,
      cursorFile, onEvent: () => {},
    });
    await waitFor(() => fake.connections.length >= 1);
    fake.connections[0].ws.send(JSON.stringify(journalFrame(42)));
    await waitFor(() => existsSync(cursorFile) && JSON.parse(readFileSync(cursorFile, 'utf-8')).cursor === 42);
    pub1.close();

    const pub2 = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, ...FAST_CURSOR,
      cursorFile, onEvent: () => {},
    });
    await waitFor(() => fake.connections.length >= 2
      && fake.connections[1].helloCursor !== undefined);
    expect(fake.connections[1].helloCursor).toBe(42);

    pub2.close();
    await fake.close();
  });

  it('dedupes: a frame with seq <= the last delivered seq is never redelivered to onEvent (replay overlap)', async () => {
    const fake = await startFakeServer();
    const cursorFile = tmpCursorFile();
    const delivered = [];
    const pub = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, ...FAST_CURSOR,
      cursorFile, onEvent: (f) => delivered.push(f.seq),
    });

    await waitFor(() => fake.connections.length >= 1);
    fake.connections[0].ws.send(JSON.stringify(journalFrame(1)));
    fake.connections[0].ws.send(JSON.stringify(journalFrame(2)));
    fake.connections[0].ws.send(JSON.stringify(journalFrame(3)));
    await waitFor(() => delivered.length >= 3);

    // Simulate a reconnect replaying from an earlier (debounced) persisted
    // cursor: seq 2 and 3 arrive again, plus a genuinely new seq 4.
    fake.connections[0].ws.send(JSON.stringify(journalFrame(2)));
    fake.connections[0].ws.send(JSON.stringify(journalFrame(3)));
    fake.connections[0].ws.send(JSON.stringify(journalFrame(4)));
    await waitFor(() => delivered.length >= 4);
    await delay(50);

    expect(delivered).toEqual([1, 2, 3, 4]);

    pub.close();
    await fake.close();
  });

  it('snapshot_required + close 4009 resets to live-only and reconnects via existing backoff', async () => {
    let helloCount = 0;
    const fake = await startFakeServer({
      onHello: (msg, conn) => {
        helloCount += 1;
        if (helloCount === 1) {
          // First hello: pretend the gap is too large. Real server sends
          // hello_ok unconditionally first (the helper does that right after
          // this callback returns), THEN snapshot_required + close(4009) —
          // reproduce that ordering with a deferred send.
          setImmediate(() => {
            conn.ws.send(JSON.stringify({ kind: 'control', op: 'snapshot_required' }));
            conn.ws.close(4009);
          });
        }
        return { seq: 0 };
      },
    });
    const cursorFile = tmpCursorFile();
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({
      url: fake.url, token: 'tok', log, ...FAST_BACKOFF, ...FAST_CURSOR,
      cursorFile, onEvent: () => {},
    });

    // Wait for the reconnect's hello to be RECEIVED (helloCursor set), not just
    // the socket accepted — otherwise this races the hello and reads the
    // initial `undefined`. See the reconnect-cursor test for the same guard.
    await waitFor(() => fake.connections.length >= 2
      && fake.connections[1].helloCursor !== undefined, 4000);
    expect(fake.connections[1].helloCursor).toBeNull();
    expect(warnings.some(w => /snapshot_required/i.test(w))).toBe(true);

    pub.close();
    await fake.close();
  });

  it('onEvent exceptions are caught+logged and never kill the socket or queue', async () => {
    const fake = await startFakeServer();
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({
      url: fake.url, token: 'tok', log, ...FAST_BACKOFF, ...FAST_CURSOR,
      onEvent: () => { throw new Error('boom'); },
    });

    await waitFor(() => fake.connections.length >= 1);
    expect(() => fake.connections[0].ws.send(JSON.stringify(journalFrame(1)))).not.toThrow();
    await waitFor(() => warnings.some(w => /onEvent/i.test(w) || /boom/.test(w)));

    // The queue/socket must still be healthy: a publish made after the
    // exception still reaches the server.
    pub.publishText('c1', { body: 'still alive', from: 'user' });
    await waitFor(() => fake.received.some(f => f.op === 'publish'));

    pub.close();
    await fake.close();
  });

  it('flushCursor() persists the cursor synchronously, bypassing the debounce (command-replay guard)', async () => {
    const fake = await startFakeServer();
    const cursorFile = tmpCursorFile();
    let flushedInsideHandler = null;
    // Deliberately a LONG debounce so a passing test proves the flush path,
    // not the timer. The onEvent handler force-flushes and inspects the file
    // synchronously — exactly what index.js does after a control-convo
    // command or a prompt_reply, so an ungraceful crash inside the debounce
    // window can't replay an already-executed command.
    let pub;
    pub = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF,
      cursorDebounceMs: 60_000,
      cursorFile,
      onEvent: (frame) => {
        pub.flushCursor();
        flushedInsideHandler = existsSync(cursorFile)
          && JSON.parse(readFileSync(cursorFile, 'utf-8')).cursor === frame.seq;
      },
    });

    await waitFor(() => fake.connections.length >= 1);
    fake.connections[0].ws.send(JSON.stringify(journalFrame(9)));
    await waitFor(() => flushedInsideHandler !== null);
    expect(flushedInsideHandler).toBe(true);

    pub.close();
    await fake.close();
  });

  it('flushCursor() is a safe no-op on the disabled publisher and without a cursorFile', async () => {
    const disabled = createJournalPublisher({ url: '', token: '', log: silentLog });
    expect(() => disabled.flushCursor()).not.toThrow();

    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF, onEvent: () => {} });
    expect(() => pub.flushCursor()).not.toThrow();
    pub.close();
    await fake.close();
  });
});

describe('tool-output streaming (streamAppend / stream_resync / finalizeToolOutput)', () => {
  it('streamAppend sends the exact frame, meta only when provided', async () => {
    const server = await startFakeServer();
    const pub = createJournalPublisher({ url: server.url, token: 't', log: silentLog });
    try {
      await waitFor(() => server.connections.length === 1);
      await delay(20); // let hello_ok land
      pub.streamAppend('c1', 'tu1', 0, '$ make\n', { tool: 'Bash', command: 'make' });
      pub.streamAppend('c1', 'tu1', 7, 'ok\n');
      await waitFor(() => server.received.length === 2);
      expect(server.received[0]).toEqual({
        op: 'stream_append', convo_id: 'c1', message_ref: 'tu1',
        offset: 0, chunk: '$ make\n', meta: { tool: 'Bash', command: 'make' },
      });
      expect(server.received[1]).toEqual({
        op: 'stream_append', convo_id: 'c1', message_ref: 'tu1', offset: 7, chunk: 'ok\n',
      });
    } finally {
      pub.close();
      await server.close();
    }
  });

  it('streamAppend before hello_ok drops silently — never queued, never replayed', async () => {
    // Point the publisher at a free port with no server yet: the ephemeral
    // must drop, while a queued publish sent in the same window survives to
    // the eventual connection.
    const port = await getFreePort();
    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${port}/ws`, token: 't', log: silentLog, backoffBaseMs: 30,
    });
    let server;
    try {
      pub.streamAppend('c1', 'tu1', 0, 'dropped', { tool: 'Bash', command: 'x' });
      pub.publishText('c1', { body: 'after' }); // queued frame DOES arrive
      server = await startFakeServer({}, port);
      await waitFor(() => server.received.some((f) => f.op === 'publish'));
      expect(server.received.some((f) => f.op === 'stream_append')).toBe(false);
    } finally {
      if (server) await server.close();
      pub.close();
    }
  });

  it('dispatches inbound stream_resync control frames to onStreamResync', async () => {
    const resyncs = [];
    const server = await startFakeServer({
      onFrame: (msg) => {
        if (msg.op === 'stream_append') {
          return { kind: 'control', op: 'stream_resync', convo_id: msg.convo_id, message_ref: msg.message_ref, have: 4 };
        }
        return null;
      },
    });
    const pub = createJournalPublisher({
      url: server.url, token: 't', log: silentLog,
      onStreamResync: (convoId, messageRef, have) => resyncs.push({ convoId, messageRef, have }),
    });
    try {
      await waitFor(() => server.connections.length === 1);
      await delay(20);
      pub.streamAppend('c1', 'tu1', 999, 'gap');
      await waitFor(() => resyncs.length === 1);
      expect(resyncs[0]).toEqual({ convoId: 'c1', messageRef: 'tu1', have: 4 });
    } finally {
      pub.close();
      await server.close();
    }
  });

  it('a throwing onStreamResync handler is contained — later frames still processed', async () => {
    const seen = [];
    const server = await startFakeServer({
      onFrame: (msg) => {
        if (msg.op === 'stream_append' && msg.offset === 999) {
          return { kind: 'control', op: 'stream_resync', convo_id: msg.convo_id, message_ref: msg.message_ref, have: 0 };
        }
        return null;
      },
    });
    const pub = createJournalPublisher({
      url: server.url, token: 't', log: silentLog,
      onStreamResync: () => { throw new Error('boom'); },
      onEvent: (msg) => seen.push(msg),
    });
    try {
      await waitFor(() => server.connections.length === 1);
      await delay(20);
      pub.streamAppend('c1', 'tu1', 999, 'gap');
      await delay(50); // resync arrives, handler throws, must be swallowed
      server.connections[0].ws.send(JSON.stringify({ kind: 'journal', seq: 1, type: 'text', payload: {} }));
      await waitFor(() => seen.length === 1);
    } finally {
      pub.close();
      await server.close();
    }
  });

  it('finalizeToolOutput is durable: exact frame, queued until a server appears', async () => {
    const port = await getFreePort();
    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${port}/ws`, token: 't', log: silentLog, backoffBaseMs: 30,
    });
    let revived;
    try {
      pub.finalizeToolOutput('c1', 'tu1', {
        message_ref: 'tu1', command: 'make', exit_code: 0, denied: false,
        truncated: false, snippet: 'ok', blob_ref: 'blob9', live_log: true,
      }, 'blob9');
      revived = await startFakeServer({}, port);
      await waitFor(() => revived.received.some((f) => f.op === 'finalize'));
      const frame = revived.received.find((f) => f.op === 'finalize');
      expect(frame).toEqual({
        op: 'finalize', convo_id: 'c1', type: 'tool_output', message_ref: 'tu1',
        payload: {
          message_ref: 'tu1', command: 'make', exit_code: 0, denied: false,
          truncated: false, snippet: 'ok', blob_ref: 'blob9', live_log: true,
        },
        blob_ref: 'blob9',
      });
    } finally {
      if (revived) await revived.close();
      pub.close();
    }
  });

  it('finalizeToolOutput defaults top-level blob_ref to null', async () => {
    const server = await startFakeServer();
    const pub = createJournalPublisher({ url: server.url, token: 't', log: silentLog });
    try {
      pub.finalizeToolOutput('c1', 'tu2', { message_ref: 'tu2', live_log: true });
      await waitFor(() => server.received.some((f) => f.op === 'finalize'));
      expect(server.received.find((f) => f.op === 'finalize').blob_ref).toBeNull();
    } finally {
      pub.close();
      await server.close();
    }
  });

  it('disabled (no url/token) publisher exposes the new methods as no-ops', () => {
    const pub = createJournalPublisher({ log: silentLog });
    expect(() => {
      pub.streamAppend('c1', 'tu1', 0, 'x', { tool: 'Bash', command: 'x' });
      pub.finalizeToolOutput('c1', 'tu1', {}, null);
    }).not.toThrow();
  });
});
