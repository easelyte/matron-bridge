// Secret scan for a file an agent sends into a room. The verdict goes on the
// user's approval card: `flagged` means something in the file looks like a
// credential, `not_scanned` means part of it could not be read as text,
// `clean` means every byte was read and nothing matched. Findings say what
// kind of secret and where ({kind, line}), never the matched value.
//
// Everything streams: a file is never held in memory whole. Plain text is
// scanned line by line; .gz is gunzipped first; .tar/.tar.gz/.tgz members are
// walked header by header (member names checked against the sensitive-name
// rules, every member's data scanned whatever its type, pax sizes honoured);
// .zip members are read through the central directory. Any other binary file is not_scanned, and so is an archive with
// bytes no member accounts for (anything after a tar's end-of-archive
// blocks but zero padding; anything in a zip outside its members, central
// directory and end record; the archive comment and each entry comment are
// scanned as text).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { isSensitivePath } from './file-link-guard.js';
import {
  readZipArchive, openZipEntry, isReadableEntry, overlappingEntries, ZIP_MEMBER_MAX_BYTES, ZIP_MAX_ENTRIES,
} from './archive-entries.js';

export const SECRET_PATTERNS = Object.freeze([
  { kind: 'private_key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/ },
  { kind: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_/ },
  { kind: 'slack_token', re: /xox[abpr]-/ },
  { kind: 'stripe_key', re: /[sr]k_live_[0-9a-zA-Z]{20,}/ },
  { kind: 'google_api_key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { kind: 'anthropic_key', re: /sk-ant-/ },
  { kind: 'openai_key', re: /sk-[A-Za-z0-9]{32,}/ },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { kind: 'url_credentials', re: /[a-z]+:\/\/[^/\s:@]+:[^/\s@]+@/ },
  { kind: 'password_assignment', re: /(password|passwd|secret|api_key|token)\s*[:=]\s*['"]?[^\s'"]{8,}/i },
].map(Object.freeze));

// Two of the patterns backtrack quadratically when V8 tries them at every
// position of a long line: url_credentials on a run of lowercase letters
// (`[a-z]+` before `://`), jwt on a run that repeats `eyJ` with no dot. A
// 1 MiB minified line would take minutes. These matchers give the same
// answer as `re.test` in linear time by trying the pattern only where it
// can start.
const URL_CRED_TAIL = /:\/\/[^/\s:@]+:[^/\s@]+@/y;
function hasUrlCredentials(text) {
  for (let i = text.indexOf('://'); i !== -1; i = text.indexOf('://', i + 1)) {
    // `[a-z]+` matches iff the character just before `://` is a-z.
    const c = text.charCodeAt(i - 1);
    if (i === 0 || c < 0x61 || c > 0x7a) continue;
    URL_CRED_TAIL.lastIndex = i;
    if (URL_CRED_TAIL.test(text)) return true;
  }
  return false;
}

const JWT_AT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/y;
const B64URL_RUN = /[A-Za-z0-9_-]+/y;
function hasJwt(text) {
  let i = text.indexOf('eyJ');
  while (i !== -1) {
    JWT_AT.lastIndex = i;
    if (JWT_AT.test(text)) return true;
    // The first segment has to run to the end of this base64url run, so a
    // later start inside the same run would fail the same way: skip it.
    B64URL_RUN.lastIndex = i;
    B64URL_RUN.test(text);
    i = text.indexOf('eyJ', B64URL_RUN.lastIndex);
  }
  return false;
}

const LINEAR_TESTS = { url_credentials: hasUrlCredentials, jwt: hasJwt };
const MATCHERS = SECRET_PATTERNS.map(({ kind, re }) => ({ kind, test: LINEAR_TESTS[kind] ?? ((t) => re.test(t)) }));

// The kinds of secret in one piece of text, in SECRET_PATTERNS order.
export function secretKindsIn(text) {
  const kinds = [];
  for (const { kind, test } of MATCHERS) if (test(text)) kinds.push(kind);
  return kinds;
}

export const MAX_FINDINGS = 50;
// The text test looks at this much of the start of a file (or member).
const SNIFF_BYTES = 8 * 1024;
// A line longer than this is scanned in pieces, each overlapping the one
// before so a secret on the seam is still seen.
const MAX_LINE_CHARS = 1024 * 1024;
const LINE_OVERLAP_CHARS = 4096;
// Metadata entries (GNU long names, pax headers) are read into memory.
const MAX_TAR_META_BYTES = 64 * 1024;
// Member names in findings are cut to this many characters.
const MAX_MEMBER_NAME_CHARS = 256;

// A compressed file (gzip, tgz, zip) may inflate to at most this many bytes
// in total, whatever its members say: 20x the file, at least 256 MiB, at
// most 10 GiB. Past it the scan stops and the file is at best not_scanned.
const MIN_INFLATE_CAP = 256 * 1024 * 1024;
const MAX_INFLATE_CAP = 10 * 1024 * 1024 * 1024;
export function inflateCapFor(fileSize) {
  return Math.min(MAX_INFLATE_CAP, Math.max(MIN_INFLATE_CAP, 20 * fileSize));
}

// Thrown to unwind a scan early: the findings cap, maxScanBytes or the
// inflate cap was hit.
const STOP = Symbol('stop-scan');

class ScanState {
  constructor(maxScanBytes, inflateCap) {
    this.findings = [];
    this.seen = new Set();
    this.notScanned = false;
    this.budget = maxScanBytes;
    this.inflateCap = inflateCap;
    this.inflated = 0;
  }

  // Count decompressed bytes against the archive-wide cap.
  chargeInflated(n) {
    this.inflated += n;
    if (this.inflated > this.inflateCap) {
      this.notScanned = true;
      throw STOP;
    }
  }

  add(kind, line) {
    const key = `${kind}\0${line}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.findings.push({ kind, line });
    if (this.findings.length >= MAX_FINDINGS) throw STOP;
  }

  // Charge `buf` against maxScanBytes and return the part that may be read.
  // Once the budget runs out the caller processes that last slice, then
  // stopIfSpent() unwinds the scan.
  take(buf) {
    if (buf.length <= this.budget) {
      this.budget -= buf.length;
      return buf;
    }
    const part = buf.subarray(0, this.budget);
    this.budget = 0;
    this.notScanned = true;
    this.spent = true;
    return part;
  }

  // `scanner` is the TextScanner reading when the budget ran out: what it
  // holds (a sniff buffer shorter than 8 KiB, a last partial line) is
  // scanned before the scan unwinds.
  stopIfSpent(scanner) {
    if (!this.spent) return;
    scanner?.end();
    throw STOP;
  }

  result() {
    let verdict = 'clean';
    if (this.findings.length) verdict = 'flagged';
    else if (this.notScanned) verdict = 'not_scanned';
    return { verdict, findings: this.findings };
  }
}

function looksLikeText(head) {
  if (head.includes(0)) return false;
  try {
    // stream: true keeps a character cut by the end of the window from
    // counting as invalid.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

// Scans one byte stream (a file, a gunzipped file, an archive member) line by
// line once its first SNIFF_BYTES pass the text test. `prefix` is the member
// name inside an archive, so lines read `member:line`.
class TextScanner {
  constructor(state, prefix = null) {
    this.state = state;
    this.prefix = prefix;
    this.mode = 'sniff';
    this.head = [];
    this.headLen = 0;
    this.pending = '';
    this.line = 1;
    this.decoder = null;
  }

  push(buf) {
    if (this.mode === 'binary' || !buf.length) return;
    if (this.mode === 'sniff') {
      this.head.push(buf);
      this.headLen += buf.length;
      if (this.headLen >= SNIFF_BYTES) this.decide();
      return;
    }
    this.feed(this.decoder.decode(buf, { stream: true }));
  }

  end() {
    if (this.mode === 'sniff') this.decide();
    if (this.mode !== 'text') return;
    this.feed(this.decoder.decode());
    if (this.pending) this.scanLine(this.pending);
    this.pending = '';
  }

  decide() {
    const all = Buffer.concat(this.head);
    this.head = null;
    if (!looksLikeText(all.subarray(0, SNIFF_BYTES))) {
      this.mode = 'binary';
      this.state.notScanned = true;
      return;
    }
    this.mode = 'text';
    this.decoder = new TextDecoder('utf-8');
    this.feed(this.decoder.decode(all, { stream: true }));
  }

  feed(str) {
    let text = this.pending + str;
    let start = 0;
    let nl;
    while ((nl = text.indexOf('\n', start)) !== -1) {
      this.scanLine(text.slice(start, nl));
      this.line++;
      start = nl + 1;
    }
    text = text.slice(start);
    if (text.length > MAX_LINE_CHARS) {
      this.scanLine(text);
      text = text.slice(-LINE_OVERLAP_CHARS);
    }
    this.pending = text;
  }

  scanLine(text) {
    const where = this.prefix === null ? this.line : `${this.prefix}:${this.line}`;
    for (const kind of secretKindsIn(text)) this.state.add(kind, where);
  }
}

// Read a stream into a TextScanner, charging maxScanBytes.
async function scanStream(state, source, scanner) {
  for await (const chunk of source) {
    scanner.push(state.take(chunk));
    state.stopIfSpent(scanner);
    // A binary file has its verdict; no need to read the rest.
    if (scanner.mode === 'binary') return;
  }
  scanner.end();
}

// Decompressed chunks from `source`, each charged to the inflate cap.
async function* inflated(state, source) {
  for await (const chunk of source) {
    state.chargeInflated(chunk.length);
    yield chunk;
  }
}

// Archive member names as reported: no leading './' or '/', and cut to
// MAX_MEMBER_NAME_CHARS. A name starting with '<' gets './' back, so no
// member can pass for a <zip comment> or <entry comment: ...> label.
function stripName(name) {
  return name.replace(/^(\.?\/)+/, '');
}
function memberName(name) {
  const clean = stripName(name);
  return (clean.startsWith('<') ? `./${clean}` : clean).slice(0, MAX_MEMBER_NAME_CHARS);
}

// Scan a comment held in memory as text under `label`.
function scanComment(state, label, buf) {
  if (!buf?.length) return;
  const scanner = new TextScanner(state, label);
  scanner.push(state.take(buf));
  state.stopIfSpent(scanner);
  scanner.end();
}

function checkMemberName(state, name) {
  const clean = stripName(name);
  if (clean && isSensitivePath('/' + clean)) state.add('sensitive_file', memberName(name));
}

function parseOctal(field) {
  // GNU base-256 for sizes over 8 GiB: high bit set, big-endian binary.
  if (field[0] & 0x80) {
    let v = 0;
    for (let i = 1; i < field.length; i++) v = v * 256 + field[i];
    return v;
  }
  const s = field.toString('ascii').replace(/[\0 ]+$/g, '').replace(/^[\0 ]+/, '');
  if (!/^[0-7]*$/.test(s)) return NaN;
  return s ? parseInt(s, 8) : 0;
}

function cString(buf) {
  const z = buf.indexOf(0);
  return (z === -1 ? buf : buf.subarray(0, z)).toString('utf8');
}

function validChecksum(h) {
  const stored = parseOctal(h.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return stored === sum;
}

// The records of a pax header as a Map (keyword -> value); a later record
// for the same keyword wins, as it does for tar itself. null when the data
// is not a whole run of records (trailing NULs aside).
function paxRecords(buf) {
  const records = new Map();
  let p = 0;
  while (p < buf.length && buf[p] !== 0) {
    const sp = buf.indexOf(0x20, p);
    if (sp === -1) return null;
    const len = parseInt(buf.subarray(p, sp).toString('ascii'), 10);
    // The length counts the record's closing newline, which must be there.
    if (!(len > sp - p + 1) || p + len > buf.length || buf[p + len - 1] !== 0x0a) return null;
    const rec = buf.subarray(sp + 1, p + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) records.set(rec.slice(0, eq), rec.slice(eq + 1));
    p += len;
  }
  return records;
}

// A pax 'size' record as a byte count; anything but a plain decimal
// number is a malformed archive.
function paxSize(value) {
  if (!/^[0-9]+$/.test(value)) throw new TarFormatError('bad pax size');
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw new TarFormatError('bad pax size');
  return size;
}

class TarFormatError extends Error {}

// Walks a tar byte stream: 512-byte headers, each followed by its data
// padded to a 512-byte boundary.
class TarWalker {
  constructor(state) {
    this.state = state;
    this.header = Buffer.alloc(0);
    this.mode = 'header';
    this.remaining = 0;
    this.padding = 0;
    this.zeroBlocks = 0;
    this.done = false;
    this.member = null; // { kind: 'file'|'meta', scanner?, chunks?, len?, type? }
    this.nextName = null;
    this.nextSize = null;
  }

  // After the end-of-archive blocks only zero padding may follow: anything
  // else is data no member accounts for.
  checkTail(buf, from) {
    for (let i = from; i < buf.length; i++) {
      if (buf[i] !== 0) { this.state.notScanned = true; return; }
    }
  }

  push(buf) {
    let p = 0;
    while (p < buf.length && !this.done) {
      if (this.mode === 'header') {
        const need = 512 - this.header.length;
        this.header = Buffer.concat([this.header, buf.subarray(p, p + need)]);
        p += Math.min(need, buf.length - p);
        if (this.header.length === 512) this.onHeader(this.header);
      } else if (this.mode === 'data') {
        const n = Math.min(this.remaining, buf.length - p);
        this.onData(buf.subarray(p, p + n));
        this.remaining -= n;
        p += n;
        if (this.remaining === 0) this.endMember();
      } else {
        const n = Math.min(this.padding, buf.length - p);
        this.padding -= n;
        p += n;
        if (this.padding === 0) this.mode = 'header';
      }
    }
    if (this.done && !this.state.notScanned) this.checkTail(buf, p);
  }

  end() {
    // Ending mid-entry means the archive was cut short. Ending on a header
    // boundary without the end-of-archive blocks is tolerated.
    if (this.mode !== 'header' || this.header.length) throw new TarFormatError('truncated');
  }

  onHeader(h) {
    this.header = Buffer.alloc(0);
    if (h.every((b) => b === 0)) {
      if (++this.zeroBlocks >= 2) this.done = true;
      return;
    }
    this.zeroBlocks = 0;
    if (!validChecksum(h)) throw new TarFormatError('bad checksum');
    let size = parseOctal(h.subarray(124, 136));
    if (!Number.isFinite(size)) throw new TarFormatError('bad size');
    const type = String.fromCharCode(h[156]);
    let name = cString(h.subarray(0, 100));
    if (h.subarray(257, 262).toString('ascii') === 'ustar') {
      const prefix = cString(h.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }

    if (type === 'L' || type === 'x' || type === 'g' || type === 'K') {
      this.member = { kind: 'meta', type, chunks: [], len: 0 };
    } else {
      if (this.nextName) name = this.nextName;
      this.nextName = null;
      // A pax 'size' record overrides the header's size field, as it does
      // for tar itself when extracting.
      if (this.nextSize !== null) size = this.nextSize;
      this.nextSize = null;
      checkMemberName(this.state, name);
      // Every member's data is scanned, whatever its type: an extractor
      // writes the data of a type it does not know (or a sparse file's
      // data) out as file content, so a directory, link or device entry
      // that carries data is read like any other member.
      this.member = { kind: 'file', scanner: new TextScanner(this.state, memberName(name)) };
    }
    this.remaining = size;
    this.padding = (512 - (size % 512)) % 512;
    this.mode = 'data';
    if (size === 0) this.endMember();
  }

  onData(chunk) {
    const m = this.member;
    if (m.kind === 'file') m.scanner.push(chunk);
    else if (m.kind === 'meta') {
      // Only the first MAX_TAR_META_BYTES are kept; len counts them all.
      if (m.len < MAX_TAR_META_BYTES) m.chunks.push(chunk.subarray(0, MAX_TAR_META_BYTES - m.len));
      m.len += chunk.length;
    }
  }

  endMember() {
    const m = this.member;
    this.member = null;
    if (m.kind === 'file') m.scanner.end();
    else if (m.kind === 'meta') {
      const data = Buffer.concat(m.chunks);
      if (m.type === 'L') this.nextName = cString(data);
      else if (m.type === 'x' || m.type === 'g') {
        // A pax header longer than what is kept may hold records that were
        // not read (a size among them), so member framing is unknown.
        if (m.len > MAX_TAR_META_BYTES) this.state.notScanned = true;
        const records = paxRecords(data);
        if (!records) {
          // Records that cannot be read may hold a size: framing unknown.
          this.state.notScanned = true;
        } else if (m.type === 'x') {
          if (records.has('path')) this.nextName = records.get('path');
          if (records.has('size')) this.nextSize = paxSize(records.get('size'));
        } else if (records.has('size')) {
          // A global size would apply to every later member; that framing
          // is not followed here, so the rest of the archive is unread.
          this.state.notScanned = true;
        }
      }
    }
    this.mode = this.padding ? 'pad' : 'header';
  }
}

async function scanTar(state, source) {
  const walker = new TarWalker(state);
  try {
    for await (const chunk of source) {
      // After the end-of-archive blocks the rest is read and must be zero
      // (record padding); reading it also keeps a gzip pipeline whole.
      walker.push(state.take(chunk));
      state.stopIfSpent(walker.member?.scanner);
    }
    walker.end();
  } catch (err) {
    if (err instanceof TarFormatError) state.notScanned = true;
    else throw err;
  }
}

async function scanZip(state, absPath, maxEntries, log) {
  let entries;
  let comment;
  try {
    let unaccounted;
    ({ entries, comment, unaccounted } = await readZipArchive(absPath, { maxEntries }));
    if (unaccounted) state.notScanned = true;
  } catch (err) {
    if (err?.name !== 'ZipFormatError') throw err;
    state.notScanned = true;
    return;
  }
  scanComment(state, '<zip comment>', comment);
  // Members sharing or overlapping their bytes are how a small zip inflates
  // to terabytes: the archive is not_scanned from the first such member on.
  const overlapping = overlappingEntries(entries);
  for (const entry of entries) {
    if (overlapping.has(entry)) {
      state.notScanned = true;
      return;
    }
    checkMemberName(state, entry.name);
    scanComment(state, `<entry comment: ${memberName(entry.name)}>`, entry.comment);
    // A directory entry has no data to read; one that carries data anyway
    // is scanned like a file.
    if (entry.name.endsWith('/') && entry.compressedSize === 0 && entry.uncompressedSize === 0) continue;
    if (!isReadableEntry(entry)) {
      state.notScanned = true;
      continue;
    }
    const scanner = new TextScanner(state, memberName(entry.name));
    let read = 0;
    try {
      const stream = await openZipEntry(absPath, entry);
      try {
        for await (const chunk of inflated(state, stream)) {
          read += chunk.length;
          // The declared size is not trusted: stop a member that inflates
          // past the per-member cap.
          if (read > ZIP_MEMBER_MAX_BYTES) throw new Error('member over cap');
          scanner.push(state.take(chunk));
          state.stopIfSpent(scanner);
          // A binary member has its verdict; inflate no more of it.
          if (scanner.mode === 'binary') break;
        }
      } finally {
        stream.destroy();
      }
      scanner.end();
    } catch (err) {
      if (err === STOP) throw err;
      if (err?.name !== 'ZipFormatError') warnScanError(log, err);
      state.notScanned = true;
    }
  }
}

// A scan cut short by an error says so in the log, by the error's code
// alone: a message could quote the file.
function warnScanError(log, err) {
  try { log?.warn?.(`[secret-scan] part of a file could not be read (${err?.code || err?.name || 'error'}); it is not_scanned`); } catch { /* logging must never throw */ }
}

function kindOf(absPath) {
  const lower = absPath.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tgz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.gz')) return 'gz';
  if (lower.endsWith('.zip')) return 'zip';
  return 'plain';
}

// -> {verdict: 'clean'|'flagged'|'not_scanned', findings: [{kind, line}]}
// maxScanBytes bounds the bytes read (after decompression); a scan cut short
// by it is at best not_scanned. Rejects only when the file cannot be opened.
// `limits` overrides the inflate cap and the zip entry cap (for tests).
export async function scanFile(absPath, { maxScanBytes = Infinity, limits = {}, log = console } = {}) {
  const st = await fsp.stat(absPath);
  if (!st.isFile()) throw new Error(`not a regular file: ${absPath}`);
  const { maxInflatedBytes = inflateCapFor(st.size), maxZipEntries = ZIP_MAX_ENTRIES } = limits;
  const state = new ScanState(maxScanBytes, maxInflatedBytes);
  const kind = kindOf(absPath);
  try {
    if (kind === 'zip') {
      await scanZip(state, absPath, maxZipEntries, log);
    } else if (kind === 'plain' || kind === 'tar') {
      const source = fs.createReadStream(absPath);
      try {
        if (kind === 'tar') await scanTar(state, source);
        else await scanStream(state, source, new TextScanner(state));
      } finally {
        source.destroy();
      }
    } else {
      // Gzip: pipeline carries errors from both the file and the inflater.
      await pipeline(fs.createReadStream(absPath), zlib.createGunzip(), async (gunzipped) => {
        const source = inflated(state, gunzipped);
        if (kind === 'tgz') await scanTar(state, source);
        else await scanStream(state, source, new TextScanner(state));
      });
    }
  } catch (err) {
    if (err !== STOP) {
      // A corrupt or unreadable stream after the file opened: whatever was
      // found so far stands, the rest was not read.
      warnScanError(log, err);
      state.notScanned = true;
    }
  }
  return state.result();
}
