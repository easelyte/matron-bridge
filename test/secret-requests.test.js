import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSecretRequests,
  formatSecretChatNotice,
  formatSecretItemBody,
  SECRET_REQUEST_TTL_MS,
  isOwnSecretFileName,
} from '../lib/secret-requests.js';

// Item #120: request_secret is non-blocking. The bridge files a tracker
// question, posts the link, and delivers the answer as a turn whenever it
// lands (up to 24 h later) — so every piece of that lifecycle lives here,
// with the clock, the timers, the filesystem, the journal and the delivery
// seam injected. No test ever handles a real secret: DUMMY is the only value.
const DUMMY = 'dummy-value-not-a-secret';

// A hand-cranked scheduler: arm() records the callback and its delay, tick()
// fires everything due. Vitest's fake timers would work too, but the store
// takes setTimer/clearTimer injected precisely so the tests can assert an
// expiry was ARMED (and cancelled) rather than infer it from wall time.
function makeScheduler() {
  let seq = 0;
  const armed = new Map();
  return {
    armed,
    setTimer: (fn, delay) => {
      const id = ++seq;
      armed.set(id, { fn, delay });
      return id;
    },
    clearTimer: (id) => { armed.delete(id); },
    fire: (id) => {
      const entry = armed.get(id);
      armed.delete(id);
      return entry.fn();
    },
    // Fire every timer whose delay is <= ms, oldest first.
    fireDue: async (ms) => {
      for (const [id, entry] of [...armed]) {
        if (entry.delay <= ms) {
          armed.delete(id);
          await entry.fn();
        }
      }
    },
    only: () => {
      const entries = [...armed.values()];
      expect(entries.length).toBe(1);
      return entries[0];
    },
  };
}

function makeItems(overrides = {}) {
  const calls = { create: [], close: [], comment: [] };
  return {
    calls,
    create: async (body) => {
      calls.create.push(body);
      return overrides.createResult ?? { status: 201, data: { item: { id: 'it_abc', num: 120 } } };
    },
    close: async (id, body) => {
      calls.close.push({ id, body });
      return overrides.closeResult ?? { status: 200, data: { item: { id, num: 120 } } };
    },
    comment: async (id, body) => {
      calls.comment.push({ id, body });
      return { status: 201, data: {} };
    },
  };
}

// A stand-in session. Only the two fields the store actually reads (`roomId`,
// `busy`) are real — everything else about a session is behind the inject /
// queue seams.
const makeSession = (roomId, { busy = false } = {}) => ({ roomId, busy });

function makeHarness(opts = {}) {
  const scheduler = makeScheduler();
  const items = opts.items ?? makeItems();
  const files = new Map();
  const removed = [];
  const turns = [];        // injected straight into a live idle session
  const queuedTurns = [];  // parked on session.queuedMessages mid-turn
  const notices = [];      // journal-side assistant notices (undeliverable)
  const chat = [];         // the room notice posted when a request is filed
  const resumes = [];      // auto-resume attempts
  let saved = opts.initial ?? null;
  let clock = opts.startAt ?? 1_000_000;

  // Live sessions by room. Default: one idle session in !room, which is the
  // ordinary case; opts.session lets a test start with none (reaped) or busy.
  const live = new Map();
  if (opts.session !== null) live.set('!room', opts.session ?? makeSession('!room'));

  const store = createSecretRequests({
    load: () => saved,
    save: (data) => { saved = JSON.parse(JSON.stringify(data)); },
    now: () => clock,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    newId: opts.newId ?? (() => 'sec-1'),
    writeSecretFile: opts.writeSecretFile ?? ((secretId, value) => {
      files.set(secretId, value);
      return `/tmp/secrets/${secretId}.txt`;
    }),
    removeSecretFile: (p) => removed.push(p),
    listSecretFiles: opts.listSecretFiles ?? (() => []),
    items,
    generateLink: opts.generateLink
      ?? ((secretId, { multiline }) => `https://viewer.example/secret?token=t-${secretId}${multiline ? '-ml' : ''}`),
    notifyChat: (record, info) => chat.push({ record, info }),
    getSession: (roomId) => live.get(roomId) ?? null,
    resumeSession: (roomId, notice) => {
      resumes.push({ roomId, notice });
      const revived = opts.resumeTo === undefined ? null : opts.resumeTo;
      if (revived) live.set(roomId, revived);
      return revived;
    },
    inject: (session, text) => {
      if (opts.injectFails) return false;
      turns.push({ roomId: session.roomId, text });
      return true;
    },
    queue: async (session, { text, preview }) => { queuedTurns.push({ roomId: session.roomId, text, preview }); },
    publishNotice: (convoId, text) => notices.push({ convoId, text }),
    log: { warn: () => {}, log: () => {} },
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.fileTtlMs ? { fileTtlMs: opts.fileTtlMs } : {}),
    ...(opts.maxPendingPerRoom ? { maxPendingPerRoom: opts.maxPendingPerRoom } : {}),
  });

  return {
    store, scheduler, items, files, removed, turns, queuedTurns, notices, chat, resumes, live,
    get saved() { return saved; },
    advance: (ms) => { clock += ms; },
    get clock() { return clock; },
  };
}

describe('formatSecretChatNotice', () => {
  it('names the label, links the form, and shows the item number and window', () => {
    const { plain, html } = formatSecretChatNotice({
      label: 'AWS access key',
      link: 'https://v/secret?token=abc',
      itemNum: 120,
    });
    expect(plain).toBe('🔐 Secret requested: AWS access key — [Enter secret](https://v/secret?token=abc) (#120, 24 h)');
    expect(html).toContain('<b>AWS access key</b>');
    expect(html).toContain('<a href="https://v/secret?token=abc">Enter secret</a>');
    expect(html).toContain('(#120, 24 h)');
  });

  it('escapes the label in the HTML variant', () => {
    const { html } = formatSecretChatNotice({ label: '<img src=x>', link: 'https://v/s', itemNum: 1 });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;');
  });

  it('escapes the link in the href, not only the label', () => {
    // VIEWER_BASE_URL is operator config, but it lands in an attribute, so a
    // quote in it must not be able to close the attribute and add another.
    const { html } = formatSecretChatNotice({ label: 'k', link: 'https://v/s?a="x onmouseover=1', itemNum: 1 });
    // The injected quote is neutralised, so the attribute still ends where
    // the template says it does and `onmouseover` stays inside the href.
    expect(html).toContain('href="https://v/s?a=&quot;x onmouseover=1">');
  });

  it('drops the item number when the item could not be filed', () => {
    const { plain } = formatSecretChatNotice({ label: 'token', link: 'https://v/s', itemNum: null });
    expect(plain).toBe('🔐 Secret requested: token — [Enter secret](https://v/s) (24 h)');
  });

  it('says so plainly when the viewer is not configured', () => {
    const { plain, html } = formatSecretChatNotice({ label: 'token', link: null, itemNum: 7 });
    expect(plain).toBe('🔐 Secret requested: token (viewer not configured)');
    expect(html).toBe(null);
  });
});

describe('formatSecretItemBody', () => {
  it('explains the need, links the form, and states the expiry and the file handoff', () => {
    const body = formatSecretItemBody({
      label: 'AWS access key',
      link: 'https://v/secret?token=abc',
      expiresAt: Date.parse('2026-09-11T10:00:00.000Z'),
    });
    expect(body).toContain('AWS access key');
    expect(body).toContain('[Enter secret](https://v/secret?token=abc)');
    expect(body).toContain('Expires 2026-09-11T10:00:00.000Z.');
    expect(body).toContain('The value is written to a file the agent reads; it never enters chat.');
  });

  it('tells the user not to type the value into the item thread', () => {
    const body = formatSecretItemBody({ label: 'k', link: 'https://v/s', expiresAt: 0 });
    expect(body).toContain('Answer with the link above — do not type the value into this thread; anything posted here is stored in the journal in plain text.');
  });

  it('never renders a link element when there is no link', () => {
    const body = formatSecretItemBody({ label: 'token', link: null, expiresAt: 0 });
    expect(body).not.toContain('](');
    expect(body).toContain('viewer is not configured');
  });
});

describe('createSecretRequests.create', () => {
  it('files a question item with the secret label, the link and the 24 h expiry', async () => {
    const h = makeHarness();
    const res = await h.store.create({ label: 'AWS access key', roomId: '!room', convoId: 'convo-1' });

    expect(res.secretId).toBe('sec-1');
    expect(res.itemNum).toBe(120);
    expect(res.itemId).toBe('it_abc');
    expect(res.itemError).toBeFalsy();

    expect(h.items.calls.create.length).toBe(1);
    const body = h.items.calls.create[0];
    expect(body.kind).toBe('question');
    expect(body.title).toBe('Secret needed: AWS access key');
    expect(body.labels).toEqual(['secret']);
    expect(body.convo_id).toBe('convo-1');
    expect(body.body).toContain('[Enter secret](https://viewer.example/secret?token=t-sec-1)');
  });

  it('posts the chat notice with the link and the item number', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'DB password', roomId: '!room', convoId: 'convo-1' });
    expect(h.chat.length).toBe(1);
    expect(h.chat[0].info.link).toBe('https://viewer.example/secret?token=t-sec-1');
    expect(h.chat[0].info.itemNum).toBe(120);
    expect(h.chat[0].info.plain).toContain('🔐 Secret requested: DB password');
    expect(h.chat[0].info.plain).toContain('(#120, 24 h)');
  });

  it('asks for a link valid for the whole 24 h request lifetime, not the short file-link window', async () => {
    const seen = [];
    const h = makeHarness({
      generateLink: (secretId, opts) => { seen.push({ secretId, ...opts }); return 'https://v/s'; },
    });
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c', multiline: true });
    expect(seen[0].ttlMs).toBe(SECRET_REQUEST_TTL_MS);
    expect(seen[0].multiline).toBe(true);
    expect(seen[0].label).toBe('k');
    expect(seen[0].roomId).toBe('!room');
  });

  it('persists only the non-sensitive record fields', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'convo-1', multiline: true });
    const rec = h.saved.requests[0];
    expect(Object.keys(rec).sort()).toEqual(
      ['convoId', 'createdAt', 'expiresAt', 'itemId', 'itemNum', 'label', 'multiline', 'roomId', 'secretId'],
    );
    // The convo id IS persisted (it is an id, not a value): without it an
    // expiry or an undeliverable submission after a restart has nowhere to go.
    expect(rec.convoId).toBe('convo-1');
    expect(rec.expiresAt - rec.createdAt).toBe(SECRET_REQUEST_TTL_MS);
    // …but never a value and never a path.
    expect(JSON.stringify(h.saved)).not.toContain('/tmp/secrets');
    expect(JSON.stringify(h.saved)).not.toContain(DUMMY);
  });

  it('arms an expiry timer 24 h out', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    expect(h.scheduler.only().delay).toBe(SECRET_REQUEST_TTL_MS);
  });

  it('still returns a usable request when the item could not be filed', async () => {
    const items = makeItems({ createResult: { status: 0, data: { error: 'journal unreachable' } } });
    const h = makeHarness({ items });
    const res = await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    expect(res.secretId).toBe('sec-1');
    expect(res.itemNum).toBe(null);
    expect(res.itemError).toBe('journal unreachable');
    // The request itself is live regardless — the link still works.
    expect(h.saved.requests.length).toBe(1);
    expect(h.chat[0].info.plain).not.toContain('#');
  });

  it('skips the item (and says why) when the session has no journal conversation', async () => {
    const h = makeHarness();
    const res = await h.store.create({ label: 'k', roomId: '!room', convoId: null });
    expect(h.items.calls.create.length).toBe(0);
    expect(res.itemError).toMatch(/journal conversation/i);
    expect(h.saved.requests[0].itemId).toBe(null);
  });
});

describe('createSecretRequests.submit line endings', () => {
  // The HTML standard makes EVERY textarea submission CRLF, so the endings the
  // user actually pasted are unrecoverable by the time the value arrives. On a
  // Unix host CRLF silently alters a PEM, a .env or a JSON key file, so a
  // multiline request normalises to LF here — on the bridge side, so any
  // client of the submit API gets the same bytes on disk. A single-line
  // request is never touched: nothing in it should contain a newline at all,
  // and if one does it was deliberate.
  async function submitInto(value, { multiline }) {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c', multiline });
    await (await h.store.submit('sec-1', value)).done;
    return h.files.get('sec-1');
  }

  it('converts CRLF to LF for a multiline request, keeping the trailing newline', async () => {
    const written = await submitInto('-----BEGIN-----\r\nabc\r\n\r\n-----END-----\r\n', { multiline: true });
    expect(written).toBe('-----BEGIN-----\nabc\n\n-----END-----\n');
    expect(written.endsWith('\n')).toBe(true);
    expect(written).not.toContain('\r');
  });

  it('leaves a lone carriage return alone', async () => {
    const written = await submitInto('a\rb\r\nc\r', { multiline: true });
    expect(written).toBe('a\rb\nc\r');
  });

  it('leaves an all-LF multiline value byte-for-byte', async () => {
    const value = 'one\ntwo\n\n';
    expect(await submitInto(value, { multiline: true })).toBe(value);
  });

  it('does not touch CRLF in a single-line request', async () => {
    const value = 'has\r\na newline somehow\r\n';
    expect(await submitInto(value, { multiline: false })).toBe(value);
  });

  it('still trims nothing at either end', async () => {
    expect(await submitInto('  padded  ', { multiline: true })).toBe('  padded  ');
  });
});

describe('createSecretRequests.submit', () => {
  it('writes the value verbatim and reports the path', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    const multi = `line1\r\nline2\n\n`;
    const res = await h.store.submit('sec-1', multi);
    await res.done;
    expect(res.ok).toBe(true);
    expect(res.path).toBe('/tmp/secrets/sec-1.txt');
    expect(h.files.get('sec-1')).toBe(multi);
  });

  it('closes the item as answered with a comment that names no value', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    const res = await h.store.submit('sec-1', DUMMY);
    await res.done;
    expect(h.items.calls.close.length).toBe(1);
    expect(h.items.calls.close[0].id).toBe('it_abc');
    expect(h.items.calls.close[0].body.resolution).toBe('answered');
    expect(h.items.calls.close[0].body.comment).toMatch(/^Submitted at \d{4}-\d\d-\d\dT.*\.$/);
    expect(JSON.stringify(h.items.calls)).not.toContain(DUMMY);
  });

  it('delivers the answer as a turn naming the label and the path', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'AWS access key', roomId: '!room', convoId: 'c' });
    const res = await h.store.submit('sec-1', DUMMY);
    await res.done;
    expect(h.turns).toEqual([{
      roomId: '!room',
      text: '🔐 Secret "AWS access key" submitted — read it from /tmp/secrets/sec-1.txt',
    }]);
    expect(JSON.stringify(h.turns)).not.toContain(DUMMY);
  });

  it('cancels the expiry timer, drops the record from the store, and schedules file cleanup', async () => {
    const h = makeHarness({ fileTtlMs: 3600000 });
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    const res = await h.store.submit('sec-1', DUMMY);
    await res.done;
    expect(h.saved.requests).toEqual([]);
    // Only the 1 h file cleanup remains armed — the 24 h expiry is gone.
    expect(h.scheduler.only().delay).toBe(3600000);
    await h.scheduler.fireDue(3600000);
    expect(h.removed).toEqual(['/tmp/secrets/sec-1.txt']);
  });

  it('rejects a second submission of the same request', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    await (await h.store.submit('sec-1', DUMMY)).done;
    const again = await h.store.submit('sec-1', DUMMY);
    expect(again.ok).toBe(false);
    expect(again.status).toBe(404);
  });

  it('rejects an unknown id and a non-string value without touching the filesystem', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    expect((await h.store.submit('nope', DUMMY)).status).toBe(404);
    const bad = await h.store.submit('sec-1', '');
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(400);
    expect(h.files.size).toBe(0);
  });

  it('leaves the request pending when the file write fails', async () => {
    const h = makeHarness({
      writeSecretFile: () => { throw new Error('EACCES'); },
    });
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    const res = await h.store.submit('sec-1', DUMMY);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.error).toContain('EACCES');
    expect(h.saved.requests.length).toBe(1);
    expect(h.turns).toEqual([]);
  });

  it('still delivers the turn when closing the item fails', async () => {
    const items = makeItems({ closeResult: { status: 0, data: { error: 'journal unreachable' } } });
    const h = makeHarness({ items });
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    const res = await h.store.submit('sec-1', DUMMY);
    await res.done;
    expect(h.turns.length).toBe(1);
  });
});

describe('turn delivery', () => {
  // The reason this matters: SESSION_IDLE_TIMEOUT_MS defaults to an hour and
  // the request window is twenty-four, so by submit time the session is
  // usually GONE. Publishing "read it from <path>" as an assistant notice
  // would show the user a sentence the agent never reads while the tracker
  // item closes as answered — the worst possible pair. So an absent session
  // is woken, exactly as an item reply wakes one, and only a wake that fails
  // degrades to a notice, in the voice that says so.
  async function submitWith(opts) {
    const h = makeHarness(opts);
    await h.store.create({ label: 'AWS access key', roomId: '!room', convoId: 'convo-1' });
    await (await h.store.submit('sec-1', DUMMY)).done;
    return h;
  }

  it('injects straight into a live idle session', async () => {
    const h = await submitWith({});
    expect(h.resumes).toEqual([]);
    expect(h.turns).toEqual([{ roomId: '!room', text: '🔐 Secret "AWS access key" submitted — read it from /tmp/secrets/sec-1.txt' }]);
    expect(h.queuedTurns).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('parks on the shared queue when a turn is running', async () => {
    const h = await submitWith({ session: makeSession('!room', { busy: true }) });
    expect(h.turns).toEqual([]);
    expect(h.queuedTurns.length).toBe(1);
    expect(h.queuedTurns[0].text).toContain('submitted — read it from');
    expect(h.queuedTurns[0].preview).toContain('AWS access key');
    expect(h.notices).toEqual([]);
  });

  it('auto-resumes a reaped session and then injects into it', async () => {
    const h = await submitWith({ session: null, resumeTo: makeSession('!room') });
    expect(h.resumes.length).toBe(1);
    expect(h.resumes[0].roomId).toBe('!room');
    expect(h.resumes[0].notice).toBe('⏳ Session was idle — auto-resuming it to receive the secret you just submitted.');
    expect(h.turns.length).toBe(1);
    expect(h.notices).toEqual([]);
  });

  it('queues instead of injecting when the resumed session is already busy', async () => {
    const h = await submitWith({ session: null, resumeTo: makeSession('!room', { busy: true }) });
    expect(h.resumes.length).toBe(1);
    expect(h.queuedTurns.length).toBe(1);
    expect(h.turns).toEqual([]);
  });

  it('falls back to an undeliverable notice — never to text that reads as if the agent has it', async () => {
    const h = await submitWith({ session: null });
    expect(h.resumes.length).toBe(1);
    expect(h.turns).toEqual([]);
    expect(h.notices.length).toBe(1);
    expect(h.notices[0].convoId).toBe('convo-1');
    expect(h.notices[0].text).toMatch(/^Couldn't deliver/);
    // The failure notice must not be mistakable for the agent's own turn.
    expect(h.notices[0].text).not.toContain('read it from');
    expect(h.notices[0].text).not.toContain('/tmp/secrets');
  });

  it('falls back to the notice when inject refuses (dead session object)', async () => {
    const h = await submitWith({ injectFails: true });
    expect(h.notices.length).toBe(1);
    expect(h.notices[0].text).toMatch(/^Couldn't deliver/);
  });

  it('does NOT wake a reaped session for an expiry — a notice records it instead', async () => {
    const h = makeHarness({ session: null, resumeTo: makeSession('!room') });
    await h.store.create({ label: 'AWS access key', roomId: '!room', convoId: 'convo-1' });
    h.advance(SECRET_REQUEST_TTL_MS);
    await h.scheduler.fireDue(SECRET_REQUEST_TTL_MS);
    expect(h.resumes).toEqual([]);
    expect(h.turns).toEqual([]);
    expect(h.notices.length).toBe(1);
    expect(h.notices[0].convoId).toBe('convo-1');
    expect(h.notices[0].text).toContain('"AWS access key" secret request expired (24 h)');
    expect(h.notices[0].text).toContain('was not woken');
  });

  it('uses the PERSISTED convo id after a restart, so a notice always has a destination', async () => {
    const seed = makeHarness();
    await seed.store.create({ label: 'k', roomId: '!room', convoId: 'convo-1' });
    const h = makeHarness({ initial: seed.saved, session: null, startAt: 1_000_000 + 1000 });
    h.store.init();
    await (await h.store.submit('sec-1', DUMMY)).done;
    expect(h.notices[0].convoId).toBe('convo-1');
  });
});

describe('per-room pending cap', () => {
  it('refuses a sixth pending request in the same room, with an actionable message', async () => {
    let n = 0;
    const h = makeHarness({ newId: () => `sec-${++n}` });
    for (let i = 0; i < 5; i++) {
      expect((await h.store.create({ label: `k${i}`, roomId: '!room', convoId: 'c' })).secretId).toBeTruthy();
    }
    const sixth = await h.store.create({ label: 'k6', roomId: '!room', convoId: 'c' });
    expect(sixth.secretId).toBeFalsy();
    expect(sixth.error).toBe('5 secret requests already pending for this session — wait for one to be answered or expire');
    expect(h.saved.requests.length).toBe(5);
    // Nothing was filed, linked or announced for the refused one.
    expect(h.items.calls.create.length).toBe(5);
    expect(h.chat.length).toBe(5);
  });

  it('holds under parallel creates: the slot is taken before the item is filed', async () => {
    let n = 0;
    // A slow tracker: every create parks until released, so all six requests
    // are in flight at once and the count alone cannot separate them.
    const release = [];
    const items = makeItems();
    const slowCreate = items.create;
    items.create = (body) => new Promise((resolve) => { release.push(() => resolve(slowCreate(body))); });
    const h = makeHarness({ newId: () => `sec-${++n}`, items });
    const results = Promise.all(Array.from({ length: 6 }, (_, i) => h.store.create({ label: `k${i}`, roomId: '!room', convoId: 'c' })));
    await new Promise((r) => setTimeout(r, 0));
    expect(release.length).toBe(5);
    for (const go of release) go();
    const out = await results;
    expect(out.filter((r) => r.secretId).length).toBe(5);
    expect(out.filter((r) => r.error).length).toBe(1);
    expect(h.saved.requests.length).toBe(5);
    expect(h.items.calls.create.length).toBe(5);
  });

  it('closes the item as answered when the submission beats the filing', async () => {
    let n = 0;
    const release = [];
    const items = makeItems();
    const slowCreate = items.create;
    items.create = (body) => new Promise((resolve) => { release.push(() => resolve(slowCreate(body))); });
    const h = makeHarness({ newId: () => `sec-${++n}`, items });
    const creating = h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    await new Promise((r) => setTimeout(r, 0));
    // The user reached the form through the item and submitted before create() resumed.
    const sub = await h.store.submit('sec-1', DUMMY);
    expect(sub.status).toBe(200);
    await sub.done;
    expect(h.items.calls.close).toEqual([]); // nothing to close yet — no item id
    release[0]();
    const r = await creating;
    expect(r.alreadySubmitted).toBe(true);
    expect(h.items.calls.close.length).toBe(1);
    expect(h.items.calls.close[0]).toMatchObject({ id: 'it_abc', body: { resolution: 'answered' } });
    expect(h.saved.requests).toEqual([]);
    expect(h.chat).toEqual([]);          // no "here is your link" for an answered request
    expect([...h.scheduler.armed.values()].filter((t) => t.delay === SECRET_REQUEST_TTL_MS)).toEqual([]); // no expiry timer
    expect(h.turns.length).toBe(1);      // the agent still got the value
  });

  it('keeps the reserved slot when the tracker rejects the item — the request itself is still live', async () => {
    const items = makeItems();
    items.create = async () => { throw new Error('network down'); };
    let n = 0;
    const h = makeHarness({ newId: () => `sec-${++n}`, items });
    const r = await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    expect(r.secretId).toBe('sec-1');
    expect(r.itemError).toBe('network down');
    expect(h.saved.requests.length).toBe(1);
    expect(h.saved.requests[0].itemId).toBeNull();
  });

  it('counts per room, and frees a slot when one is answered', async () => {
    let n = 0;
    const h = makeHarness({ newId: () => `sec-${++n}`, maxPendingPerRoom: 2 });
    await h.store.create({ label: 'a', roomId: '!room', convoId: 'c' });
    await h.store.create({ label: 'b', roomId: '!room', convoId: 'c' });
    expect((await h.store.create({ label: 'c', roomId: '!room', convoId: 'c' })).error).toBeTruthy();
    // Another room is unaffected.
    expect((await h.store.create({ label: 'd', roomId: '!other', convoId: 'c2' })).secretId).toBeTruthy();
    await (await h.store.submit('sec-1', DUMMY)).done;
    expect((await h.store.create({ label: 'e', roomId: '!room', convoId: 'c' })).secretId).toBeTruthy();
  });
});

describe('orphaned secret files', () => {
  it('sweeps files older than the file TTL at init and re-arms the young ones', async () => {
    const h = makeHarness({
      startAt: 10_000_000,
      fileTtlMs: 3600_000,
      listSecretFiles: () => [
        { path: '/tmp/secrets/11111111-1111-4111-8111-111111111111.txt', mtimeMs: 10_000_000 - 3600_001 },
        { path: '/tmp/secrets/22222222-2222-4222-8222-222222222222.txt', mtimeMs: 10_000_000 - 3600_000 },
        { path: '/tmp/secrets/33333333-3333-4333-8333-333333333333.txt', mtimeMs: 10_000_000 - 600_000 },
      ],
    });
    h.store.init();
    expect(h.removed).toEqual(['/tmp/secrets/11111111-1111-4111-8111-111111111111.txt', '/tmp/secrets/22222222-2222-4222-8222-222222222222.txt']);
    // The young one is armed for its REMAINING life, not a fresh full hour.
    expect(h.scheduler.only().delay).toBe(3600_000 - 600_000);
    await h.scheduler.fireDue(3600_000);
    expect(h.removed).toContain('/tmp/secrets/33333333-3333-4333-8333-333333333333.txt');
  });

  it('never touches a file this process could not have named, whatever the lister returns', async () => {
    const h = makeHarness({
      startAt: 10_000_000,
      fileTtlMs: 3600_000,
      listSecretFiles: () => [
        { path: '/tmp/secrets/aws-prod.txt', mtimeMs: 1 },
        { path: '/tmp/secrets/notes.txt', mtimeMs: 1 },
        { path: '/tmp/secrets/3f2504e0-4f89-11d3-9a0c-0305e82c3301.txt', mtimeMs: 1 },
        { path: '/tmp/secrets/3f2504e0-4f89-11d3-9a0c-0305e82c3301.txt.bak', mtimeMs: 1 },
      ],
    });
    h.store.init();
    expect(h.removed).toEqual(['/tmp/secrets/3f2504e0-4f89-11d3-9a0c-0305e82c3301.txt']);
  });

  it('isOwnSecretFileName accepts exactly <uuid>.txt', () => {
    expect(isOwnSecretFileName('3f2504e0-4f89-11d3-9a0c-0305e82c3301.txt')).toBe(true);
    expect(isOwnSecretFileName('3F2504E0-4F89-11D3-9A0C-0305E82C3301.txt')).toBe(true);
    for (const bad of ['aws.txt', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', '3f2504e0-4f89-11d3-9a0c-0305e82c3301.txt.bak',
      'x3f2504e0-4f89-11d3-9a0c-0305e82c3301.txt', '', null, 42]) {
      expect(isOwnSecretFileName(bad)).toBe(false);
    }
  });

  it('survives a listing that throws', () => {
    const h = makeHarness({ listSecretFiles: () => { throw new Error('ENOENT'); } });
    expect(() => h.store.init()).not.toThrow();
  });
});

describe('createSecretRequests.read (legacy GET compatibility)', () => {
  it('reports pending, then answered once, then forgets', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    expect(h.store.read('sec-1')).toEqual({ answered: false, path: null });
    await (await h.store.submit('sec-1', DUMMY)).done;
    expect(h.store.read('sec-1')).toEqual({ answered: true, path: '/tmp/secrets/sec-1.txt' });
    expect(h.store.read('sec-1')).toBe(null);
    expect(h.store.read('unknown')).toBe(null);
  });
});

describe('createSecretRequests expiry', () => {
  it('closes the item as cancelled and tells the agent when 24 h pass', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'AWS access key', roomId: '!room', convoId: 'c' });
    h.advance(SECRET_REQUEST_TTL_MS);
    await h.scheduler.fireDue(SECRET_REQUEST_TTL_MS);

    expect(h.items.calls.close[0].body).toEqual({
      resolution: 'cancelled',
      comment: 'Expired without a submission.',
    });
    expect(h.turns).toEqual([{
      roomId: '!room',
      text: '🔐 Secret "AWS access key" request expired (24 h) — ask again if still needed.',
    }]);
    expect(h.saved.requests).toEqual([]);
  });

  it('refuses a submission after expiry', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    h.advance(SECRET_REQUEST_TTL_MS);
    await h.scheduler.fireDue(SECRET_REQUEST_TTL_MS);
    expect((await h.store.submit('sec-1', DUMMY)).status).toBe(404);
  });
});

describe('createSecretRequests.init (persistence across a restart)', () => {
  let created;
  beforeEach(async () => {
    const h = makeHarness({ startAt: 1_000_000 });
    await h.store.create({ label: 'AWS access key', roomId: '!room', convoId: 'c', multiline: true });
    created = h.saved;
  });

  it('re-arms a still-pending request with its REMAINING delay', async () => {
    const h = makeHarness({ initial: created, startAt: 1_000_000 + 3600_000 });
    expect(h.store.init()).toBe(1);
    expect(h.scheduler.only().delay).toBe(SECRET_REQUEST_TTL_MS - 3600_000);
    // …and the re-armed request is still submittable.
    const res = await h.store.submit('sec-1', DUMMY);
    await res.done;
    expect(res.ok).toBe(true);
    expect(h.turns.length).toBe(1);
  });

  it('keeps multiline and the item link across the restart', async () => {
    const h = makeHarness({ initial: created, startAt: 1_000_000 });
    h.store.init();
    expect(h.store.peekForTest('sec-1').multiline).toBe(true);
    expect(h.store.peekForTest('sec-1').itemId).toBe('it_abc');
  });

  it('drops an already-expired request, closing its item as cancelled', async () => {
    const h = makeHarness({ initial: created, startAt: 1_000_000 + SECRET_REQUEST_TTL_MS + 1 });
    expect(h.store.init()).toBe(0);
    await h.store.settled();
    expect(h.items.calls.close[0].body.resolution).toBe('cancelled');
    expect(h.saved.requests).toEqual([]);
    expect(h.turns[0].text).toContain('request expired (24 h)');
    expect((await h.store.submit('sec-1', DUMMY)).status).toBe(404);
  });

  it('survives a missing or corrupt store file', () => {
    const h = makeHarness({ initial: null });
    expect(h.store.init()).toBe(0);
    const bad = createSecretRequests({
      load: () => { throw new Error('EACCES'); },
      save: () => {},
      items: makeItems(),
      generateLink: () => null,
      notifyChat: () => {},
      deliverTurn: async () => {},
      writeSecretFile: () => '/tmp/x',
      removeSecretFile: () => {},
      log: { warn: () => {} },
    });
    expect(bad.init()).toBe(0);
  });

  it('ignores malformed persisted entries', () => {
    const h = makeHarness({
      initial: { requests: [{ label: 'no id' }, null, { secretId: 'x', label: 'y', expiresAt: 'soon' }] },
    });
    expect(h.store.init()).toBe(0);
  });
});
