// Reads a zip file's members without loading the archive into memory: the
// central directory gives the member list, and each member is streamed from
// its local header (stored as is, deflate through zlib). Used by the secret
// scanner on files an agent sends into a room.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

// Members larger than this (uncompressed) are not opened.
export const ZIP_MEMBER_MAX_BYTES = 256 * 1024 * 1024;

// Archives listing more members than this are refused.
export const ZIP_MAX_ENTRIES = 100000;
// A local header is at least this long.
const LOCAL_HEADER_BYTES = 30;

// The central directory is read into memory, so it gets a bound of its own.
const MAX_CENTRAL_DIR_BYTES = 64 * 1024 * 1024;
// End of central directory record (22 bytes) plus the largest comment.
const EOCD_SEARCH_BYTES = 22 + 0xffff;

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;

export class ZipFormatError extends Error {
  constructor(message) {
    super(`zip: ${message}`);
    this.name = 'ZipFormatError';
  }
}

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

function readUInt64LE(buf, off) {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError('size out of range');
  return Number(v);
}

async function findCentralDirectory(fh, fileSize) {
  const tailLen = Math.min(fileSize, EOCD_SEARCH_BYTES);
  const tailStart = fileSize - tailLen;
  const tail = await readAt(fh, tailStart, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipFormatError('no end of central directory');
  const eocdOffset = tailStart + eocd;
  const commentLen = tail.readUInt16LE(eocd + 20);
  let zip64 = null;
  let count = tail.readUInt16LE(eocd + 10);
  let size = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);

  // Zip64: the locator sits just before the classic record and points at the
  // zip64 end record, which carries the real 64-bit values.
  const loc = eocd - 20;
  if (loc >= 0 && tail.readUInt32LE(loc) === SIG_ZIP64_LOCATOR) {
    const recOffset = readUInt64LE(tail, loc + 8);
    const rec = await readAt(fh, recOffset, 56);
    if (rec.length < 56 || rec.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new ZipFormatError('bad zip64 record');
    count = readUInt64LE(rec, 32);
    size = readUInt64LE(rec, 40);
    offset = readUInt64LE(rec, 48);
    // The record's own size field counts what follows its first 12 bytes.
    zip64 = { recordOffset: recOffset, recordBytes: 12 + readUInt64LE(rec, 4), locatorOffset: tailStart + loc };
  }
  if (size > MAX_CENTRAL_DIR_BYTES) throw new ZipFormatError('central directory too large');
  if (offset + size > fileSize) throw new ZipFormatError('central directory out of range');
  return { count, size, offset, eocdOffset, commentLen, zip64 };
}

// Apply the zip64 extended-information extra field (id 0x0001): it holds
// the values whose 32-bit slot is 0xffffffff, in a fixed order.
function applyZip64Extra(entry, extra) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    const body = extra.subarray(p + 4, p + 4 + len);
    if (id === 0x0001) {
      let q = 0;
      for (const field of ['uncompressedSize', 'compressedSize', 'localHeaderOffset']) {
        if (entry[field] === 0xffffffff) {
          if (q + 8 > body.length) throw new ZipFormatError('short zip64 extra');
          entry[field] = readUInt64LE(body, q);
          q += 8;
        }
      }
      return;
    }
    p += 4 + len;
  }
}

// -> [{name, method, flags, encrypted, compressedSize, uncompressedSize, localHeaderOffset, comment}]
export async function readZipEntries(absPath, opts = {}) {
  const fh = await fsp.open(absPath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    return (await readEntries(fh, fileSize, opts)).entries;
  } finally {
    await fh.close();
  }
}

// The members, plus what the members do not say about the file:
// -> {entries, comment, unaccounted}. `comment` is the archive comment (a
// Buffer), `unaccounted` is true when some byte of the file lies outside
// every member (local header, data, data descriptor), the central
// directory (whose entries must fill it exactly), the zip64 end records
// and the end record with its comment:
// data a reader of the members never sees, such as `cat secret >> a.zip`.
export async function readZipArchive(absPath, opts = {}) {
  const fh = await fsp.open(absPath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const { entries, layout } = await readEntries(fh, fileSize, opts);
    const spans = [
      [layout.offset, layout.offset + layout.size],
      [layout.eocdOffset, layout.eocdOffset + 22 + layout.commentLen],
    ];
    if (layout.zip64) {
      spans.push([layout.zip64.recordOffset, layout.zip64.recordOffset + layout.zip64.recordBytes]);
      spans.push([layout.zip64.locatorOffset, layout.zip64.locatorOffset + 20]);
    }
    let unaccounted = false;
    for (const entry of entries) {
      const end = await memberEnd(fh, entry);
      if (end === null) unaccounted = true;
      else spans.push([entry.localHeaderOffset, end]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    for (const [start, end] of spans) {
      if (start > covered) unaccounted = true;
      if (end > covered) covered = end;
    }
    if (covered !== fileSize || layout.trailing) unaccounted = true;
    const commentEnd = Math.min(fileSize, layout.eocdOffset + 22 + layout.commentLen);
    const comment = await readAt(fh, layout.eocdOffset + 22, Math.max(0, commentEnd - layout.eocdOffset - 22));
    return { entries, comment, unaccounted };
  } finally {
    await fh.close();
  }
}

// Where a member's bytes end: its local header, data, and data descriptor
// (flag bit 3; 12 or 16 bytes, 20 or 24 for zip64). null when the local
// header is not there.
async function memberEnd(fh, entry) {
  const local = await readAt(fh, entry.localHeaderOffset, LOCAL_HEADER_BYTES);
  if (local.length < LOCAL_HEADER_BYTES || local.readUInt32LE(0) !== SIG_LOCAL) return null;
  const nameLen = local.readUInt16LE(26);
  const extraLen = local.readUInt16LE(28);
  let end = entry.localHeaderOffset + LOCAL_HEADER_BYTES + nameLen + extraLen + entry.compressedSize;
  if (entry.flags & 0x0008) {
    const extra = await readAt(fh, entry.localHeaderOffset + LOCAL_HEADER_BYTES + nameLen, extraLen);
    const sig = await readAt(fh, end, 4);
    const signed = sig.length === 4 && sig.readUInt32LE(0) === SIG_DESCRIPTOR;
    end += (signed ? 4 : 0) + 4 + (hasZip64Extra(extra) ? 16 : 8);
  }
  return end;
}

function hasZip64Extra(extra) {
  for (let p = 0; p + 4 <= extra.length; p += 4 + extra.readUInt16LE(p + 2)) {
    if (extra.readUInt16LE(p) === 0x0001) return true;
  }
  return false;
}

async function readEntries(fh, fileSize, { maxEntries = ZIP_MAX_ENTRIES } = {}) {
  const layout = await findCentralDirectory(fh, fileSize);
  const { count, size, offset } = layout;
  if (count > maxEntries) throw new ZipFormatError('too many members');
  const cd = await readAt(fh, offset, size);
  if (cd.length < size) throw new ZipFormatError('short central directory');
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipFormatError('bad central entry');
    const flags = cd.readUInt16LE(p + 8);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ZipFormatError('bad central entry');
    const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
    const entry = {
      name: nameBuf.toString(flags & 0x0800 ? 'utf8' : 'latin1'),
      method: cd.readUInt16LE(p + 10),
      flags,
      encrypted: Boolean(flags & 0x0001),
      compressedSize: cd.readUInt32LE(p + 20),
      uncompressedSize: cd.readUInt32LE(p + 24),
      localHeaderOffset: cd.readUInt32LE(p + 42),
      comment: Buffer.from(cd.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen)),
    };
    applyZip64Extra(entry, cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  // The entries must fill the central directory exactly: bytes after the
  // last one are something no reader of the members sees.
  layout.trailing = p !== size;
  return { entries, layout };
}

// The entries whose bytes are shared with another entry: a repeated local
// header offset, or a local header inside another member's span (header
// plus compressed data). Each span is counted from its smallest possible
// size, so honest archives never trip it. -> Set of entries.
export function overlappingEntries(entries) {
  const sorted = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  const bad = new Set();
  let reach = -1;
  let owner = null;
  for (const e of sorted) {
    if (e.localHeaderOffset < reach) {
      bad.add(e);
      bad.add(owner);
    }
    const end = e.localHeaderOffset + LOCAL_HEADER_BYTES + e.compressedSize;
    if (end > reach) { reach = end; owner = e; }
  }
  return bad;
}

// True when openZipEntry can read this member.
export function isReadableEntry(entry) {
  return !entry.encrypted
    && (entry.method === 0 || entry.method === 8)
    && entry.uncompressedSize <= ZIP_MEMBER_MAX_BYTES;
}

// A Readable of the member's uncompressed bytes. Throws ZipFormatError for a
// member isReadableEntry refuses or a bad local header. The output is not
// trusted to match the declared size: the caller counts what it reads.
export async function openZipEntry(absPath, entry) {
  if (!isReadableEntry(entry)) throw new ZipFormatError('unsupported member');
  const fh = await fsp.open(absPath, 'r');
  let dataStart;
  try {
    const local = await readAt(fh, entry.localHeaderOffset, 30);
    if (local.length < 30 || local.readUInt32LE(0) !== SIG_LOCAL) throw new ZipFormatError('bad local header');
    dataStart = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  const raw = entry.compressedSize === 0
    ? Readable.from([])
    : fs.createReadStream(absPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  if (entry.method === 0) return raw;
  const inflate = zlib.createInflateRaw();
  raw.on('error', (err) => inflate.destroy(err));
  // A reader that stops early destroys the inflater; release the file too.
  inflate.on('close', () => raw.destroy());
  return raw.pipe(inflate);
}
