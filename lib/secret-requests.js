// The secure-input request lifecycle (tracker item #120).
//
// `request_secret` used to be a blocking tool: it POSTed /secret and then
// polled for five minutes, so the agent sat idle while the user found the
// key — and lost the request entirely if they took longer. Now the tool
// returns immediately, the request lives for 24 hours, it appears in the
// user's tracker as a question, and the submission comes back to the agent as
// a turn whenever it lands.
//
// Everything impure is injected (load/save, now, setTimer/clearTimer, the two
// filesystem calls, the items client, the chat notice and the turn delivery),
// the same discipline as lib/timer-command.js's store and lib/items-turn.js —
// so the whole lifecycle is unit-testable without a bridge, a journal, or a
// session.
//
// SECURITY INVARIANT: the submitted value passes through exactly two places —
// writeSecretFile, and the HTTP response's `path`. It is never logged, never
// persisted, never put in an item body or comment, and never in a turn. The
// persisted record deliberately carries no value and no path.

// Both the request lifetime AND the signed link's expiry. One number: a link
// that outlived its request would render a form whose submission 404s, and a
// link that died first would strand a request nobody can answer.
export const SECRET_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

// How long a submitted value stays on disk. Unchanged from the original
// implementation — the agent reads the file in the turn it is told about.
export const SECRET_FILE_TTL_MS = 60 * 60 * 1000;

// The auto-resume announcement. Same shape as index.js's
// JOURNAL_RESUME_NOTICE, but says which event is doing the waking —
// being woken at 3am should come with a reason.
const RESUME_NOTICE_SUBMITTED = '⏳ Session was idle — auto-resuming it to receive the secret you just submitted.';

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// The chat line. Markdown link in the plain body (the apps render it) and an
// anchor in the HTML variant, exactly as the pre-#120 notice did — plus the
// item number and the window, so the user can see at a glance that this is
// not a five-minute prompt they have already missed.
// The sweep unlinks files it did not see being written, so it must be able
// to tell its own apart: this process names a secret file `<uuid>.txt` and
// nothing else. ~/.secrets is a plain directory an operator may keep other
// credentials in — anything not shaped like our own name is not ours to
// delete, however old it is.
const OWN_SECRET_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt$/i;
export function isOwnSecretFileName(name) {
  return typeof name === 'string' && OWN_SECRET_FILE.test(name);
}

export function formatSecretChatNotice({ label, link, itemNum }) {
  if (!link) {
    return { plain: `🔐 Secret requested: ${label} (viewer not configured)`, html: null };
  }
  const suffix = Number.isInteger(itemNum) ? `(#${itemNum}, 24 h)` : '(24 h)';
  return {
    plain: `🔐 Secret requested: ${label} — [Enter secret](${link}) ${suffix}`,
    html: `🔐 Secret requested: <b>${escapeHtml(label)}</b> — <a href="${escapeHtml(link)}">Enter secret</a> ${escapeHtml(suffix)}`,
  };
}

// The tracker item's body. One line saying what is needed and where to put it,
// then the expiry and the promise that the value never enters chat — the
// user is being asked to paste a credential, so the handling has to be stated
// where they are asked, not only in the docs.
export function formatSecretItemBody({ label, link, expiresAt }) {
  const where = link
    ? `[Enter secret](${link})`
    : 'the viewer is not configured on this box, so there is no link — the request cannot be answered until it is';
  return [
    `An agent on this box needs ${label}. ${where}`,
    // The thread is the obvious place to answer a question, and answering
    // THIS one there would put a live credential into the journal in plain
    // text, where nothing later can take it back out. Say so on the item.
    'Answer with the link above — do not type the value into this thread; anything posted here is stored in the journal in plain text.',
    `Expires ${new Date(expiresAt).toISOString()}. The value is written to a file the agent reads; it never enters chat.`,
  ].join('\n\n');
}

// The ONE transformation applied to a submitted value, and only for a
// multiline request.
//
// The HTML standard's textarea wrapping transformation makes every textarea
// submission CRLF, whatever the user pasted — so by the time the value reaches
// us the original endings are unrecoverable, and "write it verbatim" would
// mean writing CRLF into a PEM, a .env or a JSON key file on a Unix host,
// silently altering it. Normalising to LF is the lesser evil, and it lives
// here rather than in the viewer so that every client of the submit API — the
// form, curl, anything later — puts the same bytes on disk.
//
// A lone \r (not part of \r\n) is left alone: it is not a line ending anyone
// produced by pressing return, so touching it would be a guess. Single-line
// requests are never touched — nothing in one should contain a newline at
// all, and if one does it was put there deliberately.
function normalizeLineEndings(value, multiline) {
  return multiline ? value.replace(/\r\n/g, '\n') : value;
}

// A persisted record is only useful if it can still be expired and answered:
// an id, a label to name it with, and a deadline to arm.
function validRecord(r) {
  return !!r
    && typeof r === 'object'
    && typeof r.secretId === 'string' && r.secretId !== ''
    && typeof r.label === 'string'
    && Number.isFinite(r.expiresAt);
}

// The persisted shape, explicitly. Written as a whitelist rather than a
// blacklist so a field added to the in-memory record later (a path, a convo
// id, anything) cannot reach the file by accident.
const persistable = (r) => ({
  secretId: r.secretId,
  label: r.label,
  roomId: r.roomId ?? null,
  // An id, not a value — and the only destination an expiry or an
  // undeliverable submission has once the live session is gone. Without it,
  // a request that outlives a bridge restart fails silently.
  convoId: r.convoId ?? null,
  itemId: r.itemId ?? null,
  itemNum: r.itemNum ?? null,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  multiline: !!r.multiline,
});

export function createSecretRequests({
  // () -> persisted blob | null, and (blob) -> void. index.js wires the same
  // read/atomic-write pair TIMERS_FILE and INFLIGHT_FILE use.
  load,
  save,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  newId,
  // (secretId, value) -> absolute path. Owns the 0600 write; throws on
  // failure, which leaves the request pending so the user can retry.
  writeSecretFile,
  // (path) -> void. The 1 h cleanup.
  removeSecretFile,
  // () -> [{ path, mtimeMs }]. Everything currently sitting in the secrets
  // directory, so a submitted file whose cleanup timer died with the bridge
  // is not left on disk forever.
  listSecretFiles = () => [],
  // The lib/items-client.js subset this needs: create + close.
  items,
  // (secretId, { label, roomId, multiline, ttlMs }) -> url | null (null when
  // the viewer is not configured).
  generateLink,
  // (record, { link, itemNum, plain, html }) -> void. Posts the chat line.
  notifyChat,

  // --- delivery seams, all four the ones lib/items-turn.js uses ---
  // (roomId) -> session | null. Live sessions only.
  getSession,
  // (roomId, noticeText) -> session | null. The idle reaper kills a session
  // after an hour and a request lives for a day, so by submit time the
  // session is usually GONE — exactly the case an item reply wakes, through
  // index.js's journalResumeRoom. Delivery into a freshly resumed session is
  // safe: sendToSession parks input in _resumeOutbox until the TUI is ready.
  resumeSession,
  // (session, text) -> boolean. Inject WITHOUT mirroring to the journal.
  inject,
  // async (session, { text, preview }) -> void. Park on the SHARED
  // session.queuedMessages while a turn is running. Never a second queue.
  queue,
  // (convoId, text) -> void. Journal-side assistant notice, used only for the
  // undeliverable case — and phrased so it can never read as the agent's turn.
  publishNotice,

  ttlMs = SECRET_REQUEST_TTL_MS,
  fileTtlMs = SECRET_FILE_TTL_MS,
  // How many requests one room may have open at once. Five is generous for
  // real use and low enough that a looping agent cannot paper the tracker
  // with questions or mint an unbounded number of live 24 h links.
  maxPendingPerRoom = 5,
  log = console,
} = {}) {
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  const loaded = (() => {
    try {
      const raw = load ? load() : null;
      if (raw && Array.isArray(raw.requests)) return raw.requests.filter(validRecord);
    } catch (e) {
      warn(`[secrets] request store load failed: ${e?.message ?? e}`);
    }
    return [];
  })();

  // secretId -> record. Pending only: a submitted request moves to `answered`
  // and leaves the persisted store entirely.
  const pending = new Map(loaded.map((r) => [r.secretId, { ...r, multiline: !!r.multiline }]));
  // secretId -> { path, label }. In memory only, and only until the legacy
  // GET /secret/:id reads it once — kept purely so an older ask-user.js that
  // still polls keeps working through a bridge upgrade.
  const answered = new Map();
  const handles = new Map(); // secretId -> expiry timer handle

  // Background work started by create/submit/expire. Tracked so tests (and a
  // shutdown) can await it; nothing here ever rejects.
  const inFlight = new Set();
  function track(promise) {
    const p = promise.catch((e) => warn(`[secrets] background step failed: ${e?.message ?? e}`));
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    return p;
  }

  function persist() {
    try {
      save({ requests: [...pending.values()].map(persistable) });
    } catch (e) {
      warn(`[secrets] request store save failed: ${e?.message ?? e}`);
    }
  }

  function disarm(secretId) {
    const handle = handles.get(secretId);
    if (handle !== undefined) clearTimer(handle);
    handles.delete(secretId);
  }

  function arm(record, delay) {
    handles.set(record.secretId, setTimer(() => { track(expire(record)); }, Math.max(0, delay)));
  }

  // Best-effort item close. A journal that is down must not stop the agent
  // being told what happened — the turn is the part that matters.
  async function closeItem(record, resolution, comment) {
    if (!record.itemId) return;
    try {
      const res = await items.close(record.itemId, { resolution, comment });
      if (res?.status !== 200 && res?.status !== 201 && res?.status !== 204) {
        warn(`[secrets] could not close item ${record.itemId} as ${resolution}: ${res?.data?.error ?? `HTTP ${res?.status}`}`);
      }
    } catch (e) {
      warn(`[secrets] closing item ${record.itemId} threw: ${e?.message ?? e}`);
    }
  }

  // One synthetic agent turn, through the four seams lib/items-turn.js uses.
  //
  // The order matters and is the whole point of this function: a request lives
  // 24 h and the idle reaper kills a session after 1 h, so "no live session"
  // is the NORMAL case at submit time, not the exception. Publishing the turn
  // text as a journal notice there would show the user a sentence the agent
  // never reads while its tracker question closes as answered. So an absent
  // session is woken first, exactly as an item reply wakes one, and only a
  // wake that fails degrades to a notice — in the voice that says the delivery
  // failed, never one that reads as if the agent has the value.
  async function tell(record, { text, preview, resumeNotice, undeliverable }) {
    try {
      let session = getSession(record.roomId);
      // Only a submission is worth waking a reaped session for: the agent
      // needs the value. An expiry carries nothing to act on, so a session
      // that is already gone stays gone and the notice records the outcome.
      if (!session && resumeNotice) session = resumeSession(record.roomId, resumeNotice);
      if (!session) {
        publishNotice(record.convoId ?? null, undeliverable);
        return;
      }
      // Read busy AFTER the resume, like lib/items-turn.js reads it after the
      // transcribe: a turn that ended while we were waking should inject.
      if (session.busy) {
        await queue(session, { text, preview });
        return;
      }
      if (!inject(session, text)) publishNotice(record.convoId ?? null, undeliverable);
    } catch (e) {
      warn(`[secrets] could not deliver the turn for ${record.secretId}: ${e?.message ?? e}`);
      try { publishNotice(record.convoId ?? null, undeliverable); }
      catch { /* a notice must never mask the original failure */ }
    }
  }

  // 24 h with no submission. The request is gone, the question is closed as
  // cancelled, and the agent is told — a silent expiry would leave it waiting
  // for a turn that is never coming.
  async function expire(record) {
    handles.delete(record.secretId);
    // Identity, not presence: anything but this exact record under this id
    // means it was already submitted (or replaced), and this timer is stale.
    if (pending.get(record.secretId) !== record) return;
    pending.delete(record.secretId);
    persist();
    await closeItem(record, 'cancelled', 'Expired without a submission.');
    await tell(record, {
      text: `🔐 Secret "${record.label}" request expired (24 h) — ask again if still needed.`,
      preview: `🔐 ${record.label} (expired)`,
      resumeNotice: null,
      undeliverable: `🔐 The "${record.label}" secret request expired (24 h) without a submission. The agent's session was idle, so it was not woken to hear this — ask again in a new turn if the secret is still needed.`,
    });
  }

  // Sweep the secrets directory. A submitted value is unlinked an hour later
  // by a timer — which dies with the bridge, so a restart in that hour used to
  // strand the file on disk forever. Anything already past its hour goes now;
  // anything younger gets a timer for its REMAINING life, not a fresh hour.
  function sweepOrphanedFiles() {
    let entries;
    try {
      entries = listSecretFiles() || [];
    } catch (e) {
      warn(`[secrets] could not list the secrets directory: ${e?.message ?? e}`);
      return;
    }
    for (const entry of entries) {
      if (!entry || typeof entry.path !== 'string' || !Number.isFinite(entry.mtimeMs)) continue;
      // Second guard on top of the lister's: never touch a file this process
      // could not have written, whatever the lister handed back.
      if (!isOwnSecretFileName(entry.path.slice(entry.path.lastIndexOf('/') + 1))) continue;
      const remaining = fileTtlMs - (now() - entry.mtimeMs);
      if (remaining <= 0) {
        try { removeSecretFile(entry.path); } catch (e) { warn(`[secrets] sweep failed: ${e?.message ?? e}`); }
        continue;
      }
      const handle = setTimer(() => {
        try { removeSecretFile(entry.path); } catch (e) { warn(`[secrets] cleanup failed: ${e?.message ?? e}`); }
      }, remaining);
      if (typeof handle?.unref === 'function') handle.unref();
    }
  }

  async function fileItem({ label, convoId, link, expiresAt }) {
    if (!convoId) {
      return { itemId: null, itemNum: null, itemError: 'no journal conversation for this session yet' };
    }
    try {
      const res = await items.create({
        kind: 'question',
        title: `Secret needed: ${label}`,
        body: formatSecretItemBody({ label, link, expiresAt }),
        labels: ['secret'],
        convo_id: convoId,
      });
      const item = res?.data?.item;
      if ((res?.status === 200 || res?.status === 201) && item) {
        return { itemId: item.id ?? null, itemNum: Number.isInteger(item.num) ? item.num : null, itemError: null };
      }
      return {
        itemId: null,
        itemNum: null,
        itemError: res?.data?.error || `HTTP ${res?.status ?? '?'}`,
      };
    } catch (e) {
      return { itemId: null, itemNum: null, itemError: e?.message ?? String(e) };
    }
  }

  return {
    // Re-arm everything persisted from a previous bridge run. Anything that
    // came due while the bridge was down expires now (closing its item), so a
    // restart can never resurrect a dead link. Returns how many are live.
    init() {
      sweepOrphanedFiles();
      const t = now();
      let live = 0;
      for (const record of [...pending.values()]) {
        if (record.expiresAt <= t) {
          track(expire(record));
          continue;
        }
        arm(record, record.expiresAt - t);
        live++;
      }
      return live;
    },

    async create({ label, roomId, convoId = null, multiline = false }) {
      // Checked BEFORE anything is minted, filed or announced: past the cap
      // nothing at all happens, so a looping agent cannot leave a trail of
      // half-made requests behind its error message.
      let open = 0;
      for (const r of pending.values()) if (r.roomId === roomId) open++;
      if (open >= maxPendingPerRoom) {
        return { error: `${maxPendingPerRoom} secret requests already pending for this session — wait for one to be answered or expire` };
      }

      const secretId = newId();
      const createdAt = now();
      const expiresAt = createdAt + ttlMs;
      const link = generateLink(secretId, { label, roomId, multiline: !!multiline, ttlMs });

      const record = {
        secretId,
        label,
        roomId: roomId ?? null,
        convoId,
        itemId: null,
        itemNum: null,
        createdAt,
        expiresAt,
        multiline: !!multiline,
      };
      // The slot is taken NOW, before filing the item awaits the network:
      // two creates for one room racing through the count above would both
      // pass it otherwise, and the cap would bound nothing. Nobody can submit
      // against this record yet — the link is announced only below.
      pending.set(secretId, record);

      let filed;
      try {
        filed = await fileItem({ label, convoId, link, expiresAt });
      } catch (e) {
        pending.delete(secretId);
        throw e;
      }
      const { itemId, itemNum, itemError } = filed;
      record.itemId = itemId;
      record.itemNum = itemNum;

      // The tracker item is the link's first home, so a submission can land
      // while the item was still being filed: submit() then found this
      // record, took the value, and skipped closeItem because itemId was
      // still null. If the record is no longer pending, that is what
      // happened — close the question it never knew about, and mint nothing
      // else (no timer, no chat notice) for a request that is already over.
      if (pending.get(secretId) !== record) {
        await closeItem(record, 'answered', `Submitted at ${new Date(now()).toISOString()}.`);
        return { secretId, itemId, itemNum, itemError, expiresAt, link, alreadySubmitted: true };
      }
      persist();
      arm(record, ttlMs);

      const { plain, html } = formatSecretChatNotice({ label, link, itemNum });
      try {
        notifyChat(record, { link, itemNum, plain, html });
      } catch (e) {
        warn(`[secrets] chat notice failed for ${secretId}: ${e?.message ?? e}`);
      }

      return { secretId, itemId, itemNum, itemError, expiresAt, link };
    },

    // The value's only stop on its way to disk. Returns fast — the item close
    // and the agent turn run on `done`, so a slow journal never holds the
    // user's browser open on the submit POST.
    async submit(secretId, value) {
      const record = pending.get(secretId);
      if (!record) return { ok: false, status: 404, error: 'Secret request not found or already submitted' };
      if (typeof value !== 'string' || value === '') return { ok: false, status: 400, error: 'value is required' };

      let path;
      try {
        path = writeSecretFile(secretId, normalizeLineEndings(value, record.multiline));
      } catch (e) {
        // Deliberately leaves the request pending: the link still works, so a
        // transient write failure is retryable rather than terminal.
        return { ok: false, status: 500, error: `Failed to write secret: ${e?.message ?? e}` };
      }

      disarm(secretId);
      pending.delete(secretId);
      persist();
      answered.set(secretId, { path, label: record.label });

      const cleanup = setTimer(() => {
        answered.delete(secretId);
        try { removeSecretFile(path); } catch (e) { warn(`[secrets] cleanup failed: ${e?.message ?? e}`); }
      }, fileTtlMs);
      if (typeof cleanup?.unref === 'function') cleanup.unref();

      const done = track((async () => {
        await closeItem(record, 'answered', `Submitted at ${new Date(now()).toISOString()}.`);
        await tell(record, {
          text: `🔐 Secret "${record.label}" submitted — read it from ${path}`,
          preview: `🔐 ${record.label} submitted`,
          resumeNotice: RESUME_NOTICE_SUBMITTED,
          // Deliberately names neither the path nor anything that could read
          // as the agent's own turn: this is the journal telling the USER the
          // handoff failed, and the path would be a durable, mirrored record
          // of where a live credential is sitting.
          undeliverable: `Couldn't deliver the secret to the agent — the session isn't available. The value you submitted is saved and will be deleted in an hour; ask the agent to request it again.`,
        });
      })());

      return { ok: true, status: 200, path, done };
    },

    // Legacy GET /secret/:id. Pending -> {answered:false}; submitted -> the
    // path, once; anything else -> null (404). Kept for a bridge upgraded
    // under a running ask-user.js that still polls.
    read(secretId) {
      if (pending.has(secretId)) return { answered: false, path: null };
      const done = answered.get(secretId);
      if (!done) return null;
      answered.delete(secretId);
      return { answered: true, path: done.path };
    },

    // TEST-ONLY. Nothing in index.js calls this, and it deliberately returns
    // only what is already on disk, so it cannot become a leak even if
    // something later does.
    peekForTest(secretId) {
      const r = pending.get(secretId);
      return r ? persistable(r) : null;
    },

    // Await whatever background item/turn work is outstanding.
    settled() {
      return Promise.all([...inFlight]);
    },
  };
}
