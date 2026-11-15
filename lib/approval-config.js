// The approval-key settings, read from the environment once at boot.
//
//   MATRON_APPROVAL_KEYS_FILE    path of the pinned keys file; unset = off
//   MATRON_APPROVAL_MAX_AGE_MS   an upper bound on every freshness window
//   MATRON_APPROVAL_JOURNAL_HOST the host statements name, when the journal's
//                                public URL is not the one this bridge dials
//   MATRON_STEP_UP_ALL=1         every question this box files is step-up
//   MATRON_LOCKED=1              locked mode (needs the keys file)
//   MATRON_UNLOCK_MAX_MINUTES    the longest unlock window, default 120

// The journal as a statement names it: the URL's host, lowercased, with the
// port only when it is not the scheme's default.
export function journalHostOf(wsUrl) {
  if (typeof wsUrl !== 'string' || !wsUrl) return null;
  try {
    const u = new URL(wsUrl.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://'));
    return u.host.toLowerCase() || null;
  } catch {
    return null;
  }
}

const positive = (v) => {
  const n = Number(v);
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

export function readApprovalConfig(env = process.env, { journalWsUrl = '' } = {}) {
  const keysFile = typeof env.MATRON_APPROVAL_KEYS_FILE === 'string' ? env.MATRON_APPROVAL_KEYS_FILE.trim() : '';
  const given = typeof env.MATRON_APPROVAL_JOURNAL_HOST === 'string' ? env.MATRON_APPROVAL_JOURNAL_HOST.trim().toLowerCase() : '';
  const locked = env.MATRON_LOCKED === '1';
  if (locked && !keysFile) {
    throw new Error('MATRON_LOCKED=1 needs MATRON_APPROVAL_KEYS_FILE: a locked box is unlocked with a signed statement, checked against the keys pinned in that file');
  }
  const cap = positive(env.MATRON_UNLOCK_MAX_MINUTES);
  return {
    keysFile,
    maxAgeMs: positive(env.MATRON_APPROVAL_MAX_AGE_MS),
    stepUpAll: env.MATRON_STEP_UP_ALL === '1',
    journalHost: given || journalHostOf(journalWsUrl),
    locked,
    unlockMaxMinutes: cap && cap >= 1 ? Math.floor(cap) : 120,
  };
}
