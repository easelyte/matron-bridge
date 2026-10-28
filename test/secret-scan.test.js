import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { scanFile, SECRET_PATTERNS, secretKindsIn, inflateCapFor } from '../lib/secret-scan.js';
import { readZipEntries, overlappingEntries, ZIP_MEMBER_MAX_BYTES, ZIP_MAX_ENTRIES } from '../lib/archive-entries.js';

// Fake secrets are assembled from pieces so no key-shaped literal sits in
// this file for the repository's own secret scanners to trip on.
const FAKE = {
  aws: 'AK' + 'IA' + 'EXAMPLE0' + 'EXAMPLE1',
  jwt: 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'J' + 'zdWIiOiJhbGljZSJ9' + '.' + 'c2lnbmF0dXJlLXZhbHVl',
  pgUrl: 'postgres' + '://' + 'u' + ':' + 'p' + '@' + 'db.example.com/app',
  privateKeyHeader: '-----' + 'BEGIN RSA ' + 'PRIVATE KEY' + '-----',
  github: 'gh' + 'p_' + 'a1B2c3D4e5'.repeat(4),
  githubPat: 'github' + '_pat_' + '11ABCDEFG0' + 'x'.repeat(40),
  slack: 'xo' + 'xb-' + '1234567890-abcdef',
  stripe: 's' + 'k_live_' + 'Zz09'.repeat(6),
  google: 'AI' + 'za' + 'Sy' + 'A1b2C3d4E5'.repeat(3) + '_-abc',
  anthropic: 'sk' + '-ant-' + 'api03-' + 'q'.repeat(30),
  openai: 'sk' + '-' + 'Ab12'.repeat(10),
  password: 'pass' + 'word' + ' = "' + 'hunter2' + 'hunter2' + '"',
};

let dir;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'secret-scan-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function fixture(name, content) {
  const p = path.join(dir, `${n++}-${name}`);
  writeFileSync(p, content);
  return p;
}

// --- tar fixtures (ustar, built by hand) ---
function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0001750\0', 108, 'ascii');
  h.write('0001750\0', 116, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}
function makeTar(entries) {
  const parts = [];
  for (const { name, data = '', type = '0' } of entries) {
    const body = Buffer.from(data);
    parts.push(tarHeader(name, body.length, type), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function pad512(buf) {
  return Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);
}
// A pax extended header's data: one "<len> key=value\n" record per entry,
// where <len> counts the whole record including itself.
function paxData(records) {
  const parts = [];
  for (const [key, value] of Object.entries(records)) {
    const rest = ` ${key}=${value}\n`;
    let len = rest.length + 1;
    while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
    parts.push(`${len}${rest}`);
  }
  return Buffer.from(parts.join(''));
}

// --- zip fixtures (built by hand) ---
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// `centrals` lists the central entries to write, default one per member:
// [{of: memberIndex, name?, offset?, comment?}] lets a test alias or
// misplace them, or give one an entry comment.
// A member with `descriptor` has its sizes in a data descriptor after its
// data ('sig': with the optional signature), the way streaming zip writers
// do. `comment` is the archive comment after the end record.
function makeZip(entries, centrals = null, { comment = '' } = {}) {
  const locals = [];
  const members = [];
  let offset = 0;
  for (const { name, data = '', method = 8, descriptor = false } of entries) {
    const raw = Buffer.from(data);
    const comp = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800 | (descriptor ? 0x0008 : 0), 6);
    local.writeUInt16LE(method, 8);
    if (!descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(comp.length, 18);
      local.writeUInt32LE(raw.length, 22);
    }
    local.writeUInt16LE(nameBuf.length, 26);
    let desc = Buffer.alloc(0);
    if (descriptor) {
      desc = Buffer.alloc(descriptor === 'sig' ? 16 : 12);
      let q = 0;
      if (descriptor === 'sig') { desc.writeUInt32LE(0x08074b50, 0); q = 4; }
      desc.writeUInt32LE(crc, q);
      desc.writeUInt32LE(comp.length, q + 4);
      desc.writeUInt32LE(raw.length, q + 8);
    }
    locals.push(local, nameBuf, comp, desc);
    members.push({ name, method, crc, compLen: comp.length, rawLen: raw.length, offset, flags: 0x0800 | (descriptor ? 0x0008 : 0) });
    offset += 30 + nameBuf.length + comp.length + desc.length;
  }
  const specs = centrals ?? members.map((_, i) => ({ of: i }));
  const cdParts = [];
  for (const spec of specs) {
    const m = members[spec.of];
    const nameBuf = Buffer.from(spec.name ?? m.name, 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(m.flags, 8);
    central.writeUInt16LE(m.method, 10);
    central.writeUInt32LE(m.crc, 16);
    central.writeUInt32LE(m.compLen, 20);
    central.writeUInt32LE(m.rawLen, 24);
    const entryComment = Buffer.from(spec.comment ?? '');
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(entryComment.length, 32);
    central.writeUInt32LE(spec.offset ?? m.offset, 42);
    cdParts.push(central, nameBuf, entryComment);
  }
  const cd = Buffer.concat(cdParts);
  const commentBuf = Buffer.from(comment);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  return Buffer.concat([...locals, cd, eocd, commentBuf]);
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.alloc(64, 0),
]);

describe('SECRET_PATTERNS', () => {
  it('has every kind from the spec', () => {
    const kinds = new Set(SECRET_PATTERNS.map((p) => p.kind));
    for (const k of ['private_key', 'aws_access_key', 'github_token', 'slack_token', 'stripe_key',
      'google_api_key', 'anthropic_key', 'openai_key', 'jwt', 'url_credentials', 'password_assignment']) {
      expect(kinds.has(k), k).toBe(true);
    }
  });
});

describe('secretKindsIn', () => {
  const J = 'ey' + 'J';
  // The scanner uses linear-time matchers for url_credentials and jwt; they
  // must agree with the published regexes.
  const samples = [
    ...Object.values(FAKE),
    'plain words only', '://u:p@h', 'http' + '://example.com/path', 'HTTP' + '://u:p@example.com',
    'x' + '://u:p@h', '1' + '://u:p@h', 'a' + '://u:p/@h', 'a' + '://:p@h', 'a' + '://u:@h',
    'see ' + 'ftp' + '://u:p@h and ' + 'https' + '://bob:pw@example.com',
    'a' + '://b:c a' + '://d:e@f', J, J + 'a.b', J + 'a.b.c', J + '.b.c', 'x' + J + 'a.b.c',
    J + J + '.' + J, J + 'a.' + J.repeat(5), J + 'a-b_c.d.e', J + 'a'.repeat(10) + '.x.',
  ];
  it.each(samples)('agrees with SECRET_PATTERNS on %j', (text) => {
    const expected = SECRET_PATTERNS.filter(({ re }) => re.test(text)).map(({ kind }) => kind);
    expect(secretKindsIn(text)).toEqual(expected);
  });

  // A synchronous regex blocks the event loop, so a quadratic match would
  // hang rather than time out; keep the inputs big enough to notice.
  it('stays linear on long runs that defeat the plain regexes', () => {
    const t = Date.now();
    expect(secretKindsIn('a'.repeat(1 << 20))).toEqual([]);
    expect(secretKindsIn(J.repeat(1 << 18))).toEqual([]);
    expect(secretKindsIn(J + 'a.' + J.repeat(1 << 18))).toEqual([]);
    expect(secretKindsIn('a' + '://b:'.repeat(1 << 17))).toEqual([]);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe('scanFile: plain text', () => {
  it('clean text is clean', async () => {
    const p = fixture('notes.md', '# Notes\n\nalice met bob at example.com\npassword: short\n');
    expect(await scanFile(p)).toEqual({ verdict: 'clean', findings: [] });
  });

  it('empty file is clean', async () => {
    expect(await scanFile(fixture('empty.txt', ''))).toEqual({ verdict: 'clean', findings: [] });
  });

  it('flags a fake AWS key with the right 1-based line', async () => {
    const p = fixture('deploy.sh', `#!/bin/sh\necho hi\nexport KEY_ID=${FAKE.aws}\n`);
    const r = await scanFile(p);
    expect(r.verdict).toBe('flagged');
    expect(r.findings).toEqual([{ kind: 'aws_access_key', line: 3 }]);
  });

  it.each([
    ['private_key', FAKE.privateKeyHeader],
    ['github_token', FAKE.github],
    ['github_token', FAKE.githubPat],
    ['slack_token', FAKE.slack],
    ['stripe_key', FAKE.stripe],
    ['google_api_key', FAKE.google],
    ['anthropic_key', FAKE.anthropic],
    ['openai_key', FAKE.openai],
    ['jwt', FAKE.jwt],
    ['url_credentials', FAKE.pgUrl],
    ['password_assignment', FAKE.password],
  ])('detects %s', async (kind, secret) => {
    const r = await scanFile(fixture('x.txt', `line one\n  value ${secret} tail\n`));
    expect(r.verdict).toBe('flagged');
    expect(r.findings).toContainEqual({ kind, line: 2 });
  });

  it('password_assignment is case-insensitive', async () => {
    const r = await scanFile(fixture('x.yml', 'API' + '_KEY: abcdefgh12345\n'));
    expect(r.findings).toEqual([{ kind: 'password_assignment', line: 1 }]);
  });

  it('never includes the matched value in the findings', async () => {
    const all = Object.values(FAKE).join('\n');
    const r = await scanFile(fixture('all.txt', all));
    expect(r.verdict).toBe('flagged');
    const json = JSON.stringify(r);
    for (const v of Object.values(FAKE)) expect(json).not.toContain(v);
    for (const f of r.findings) expect(Object.keys(f).sort()).toEqual(['kind', 'line']);
  });

  it('finds secrets well past the 8 KiB sniff window, counting lines across chunks', async () => {
    const filler = 'just some ordinary text here\n'.repeat(5000);
    const r = await scanFile(fixture('big.log', filler + `token ${FAKE.aws}\n`));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 5001 }] });
  });

  it('finds a secret on a single very long line', async () => {
    const r = await scanFile(fixture('min.js', 'a'.repeat(3 * 1024 * 1024) + ' ' + FAKE.aws + ' ' + 'b'.repeat(1000)));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 1 }] });
  });

  it('reports each kind once per line', async () => {
    const r = await scanFile(fixture('dup.txt', `${FAKE.aws} ${FAKE.aws}\n`));
    expect(r.findings).toEqual([{ kind: 'aws_access_key', line: 1 }]);
  });

  it('caps findings at 50', async () => {
    const r = await scanFile(fixture('many.txt', `${FAKE.aws}\n`.repeat(200)));
    expect(r.verdict).toBe('flagged');
    expect(r.findings).toHaveLength(50);
  });

  it('PNG bytes are not_scanned', async () => {
    expect(await scanFile(fixture('pic.png', PNG))).toEqual({ verdict: 'not_scanned', findings: [] });
  });

  it('invalid UTF-8 in the first 8 KiB is not_scanned', async () => {
    const r = await scanFile(fixture('latin.txt', Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x41, 0x0a])));
    expect(r.verdict).toBe('not_scanned');
  });

  it('a multibyte character cut by the 8 KiB window still counts as text', async () => {
    const body = 'a'.repeat(8191) + 'é' + '\n' + FAKE.aws + '\n';
    const r = await scanFile(fixture('utf8.txt', body));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 2 }] });
  });

  it('maxScanBytes stops early: not_scanned when nothing found before the limit', async () => {
    const p = fixture('long.txt', 'ok\n'.repeat(10000) + FAKE.aws + '\n');
    expect(await scanFile(p, { maxScanBytes: 1024 })).toEqual({ verdict: 'not_scanned', findings: [] });
  });

  it('maxScanBytes: a finding before the limit still flags', async () => {
    const p = fixture('long2.txt', FAKE.aws + '\n' + 'ok\n'.repeat(10000));
    const r = await scanFile(p, { maxScanBytes: 1024 });
    expect(r.verdict).toBe('flagged');
  });

  it('rejects for a missing file', async () => {
    await expect(scanFile(path.join(dir, 'nope.txt'))).rejects.toThrow();
  });
});

describe('scanFile: gzip', () => {
  it('flags gzipped SQL with a credentialed URL', async () => {
    const sql = `-- dump\nCREATE TABLE t (id int);\n-- source ${FAKE.pgUrl}\n`;
    const r = await scanFile(fixture('dump.sql.gz', zlib.gzipSync(sql)));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'url_credentials', line: 3 }] });
  });

  it('clean gzipped text is clean', async () => {
    expect(await scanFile(fixture('a.txt.gz', zlib.gzipSync('hello\nworld\n'))))
      .toEqual({ verdict: 'clean', findings: [] });
  });

  it('gzipped binary is not_scanned', async () => {
    expect((await scanFile(fixture('p.png.gz', zlib.gzipSync(PNG)))).verdict).toBe('not_scanned');
  });

  it('large gzipped binary stops at the sniff and is not_scanned', async () => {
    const bin = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < bin.length; i += 4) bin.writeUInt32LE((i * 2654435761) >>> 0, i);
    const r = await scanFile(fixture('blob.bin.gz', zlib.gzipSync(bin, { level: 1 })));
    expect(r).toEqual({ verdict: 'not_scanned', findings: [] });
  });

  it('maxScanBytes under the sniff window still scans what was read', async () => {
    const p = fixture('short.txt.gz', zlib.gzipSync(FAKE.aws + '\n' + 'ok\n'.repeat(10000)));
    expect(await scanFile(p, { maxScanBytes: 512 })).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 1 }] });
  });

  it('corrupt gzip is not_scanned', async () => {
    expect((await scanFile(fixture('bad.gz', Buffer.from('not gzip at all')))).verdict).toBe('not_scanned');
  });
});

describe('scanFile: tar', () => {
  it('flags a .env member as sensitive_file', async () => {
    const tar = makeTar([{ name: 'app/README.md', data: 'hi\n' }, { name: 'app/.env', data: 'FOO=bar\n' }]);
    const r = await scanFile(fixture('bundle.tar', tar));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'sensitive_file', line: 'app/.env' }] });
  });

  it('flags a member inside a sensitive directory', async () => {
    const tar = makeTar([{ name: 'home/.ssh/', type: '5' }, { name: 'home/.ssh/known_hosts', data: 'x\n' }]);
    const r = await scanFile(fixture('ssh.tar', tar));
    expect(r.findings).toContainEqual({ kind: 'sensitive_file', line: 'home/.ssh/known_hosts' });
  });

  it('scans text members and reports member:line', async () => {
    const tar = makeTar([
      { name: 'src/a.js', data: 'x'.repeat(700) + '\n' },
      { name: 'src/b.js', data: `const a = 1;\nconst k = '${FAKE.aws}';\n` },
    ]);
    const r = await scanFile(fixture('src.tar', tar));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 'src/b.js:2' }] });
  });

  it('clean tar is clean; a binary member makes it not_scanned', async () => {
    expect(await scanFile(fixture('ok.tar', makeTar([{ name: 'a.txt', data: 'hello\n' }]))))
      .toEqual({ verdict: 'clean', findings: [] });
    const r = await scanFile(fixture('bin.tar', makeTar([{ name: 'a.txt', data: 'hello\n' }, { name: 'p.png', data: PNG }])));
    expect(r.verdict).toBe('not_scanned');
  });

  it('handles .tar.gz and .tgz', async () => {
    const tar = makeTar([{ name: 'conf/settings.ini', data: `[db]\nurl=${FAKE.pgUrl}\n` }]);
    for (const ext of ['tar.gz', 'tgz']) {
      const r = await scanFile(fixture(`b.${ext}`, zlib.gzipSync(tar)));
      expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'url_credentials', line: 'conf/settings.ini:2' }] });
    }
  });

  it('uses a GNU long name for the next member', async () => {
    const longName = 'deep/'.repeat(25) + 'prod.env';
    const tar = makeTar([{ name: '././@LongLink', type: 'L', data: longName + '\0' }, { name: longName.slice(0, 99), data: 'x\n' }]);
    const r = await scanFile(fixture('long.tar', tar));
    expect(r.findings).toEqual([{ kind: 'sensitive_file', line: longName }]);
  });

  it('data after the end-of-archive blocks makes it not_scanned (cat secret >> archive)', async () => {
    const tar = makeTar([{ name: 'a.txt', data: 'hello\n' }]);
    expect((await scanFile(fixture('tail.tar', Buffer.concat([tar, Buffer.from(`${FAKE.aws}\n`)])))).verdict).toBe('not_scanned');
    // Record padding (zeros) after the end blocks is still clean.
    expect((await scanFile(fixture('padded.tar', Buffer.concat([tar, Buffer.alloc(8192)])))).verdict).toBe('clean');
    // One non-zero byte far into the padding is enough.
    const late = Buffer.concat([tar, Buffer.alloc(8192)]);
    late[late.length - 1] = 0x41;
    expect((await scanFile(fixture('late.tar', late))).verdict).toBe('not_scanned');
    for (const ext of ['tar.gz', 'tgz']) {
      const gz = Buffer.concat([zlib.gzipSync(tar), Buffer.from(`${FAKE.aws}\n`)]);
      expect((await scanFile(fixture(`tail.${ext}`, gz))).verdict).toBe('not_scanned');
      expect((await scanFile(fixture(`intail.${ext}`, zlib.gzipSync(Buffer.concat([tar, Buffer.from(`${FAKE.aws}\n`)]))))).verdict).toBe('not_scanned');
    }
  });

  it('scans the data of a member of any type, not only plain files', async () => {
    const key = `${FAKE.privateKeyHeader}\nAAAA\n`;
    // Unknown, sparse, directory, symlink and contiguous types alike.
    for (const type of ['A', 'S', '5', '2', '7']) {
      const tar = makeTar([{ name: 'a.txt', data: 'hello\n' }, { name: 'payload', type, data: key }]);
      const r = await scanFile(fixture(`type-${type}.tar`, tar));
      expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'private_key', line: 'payload:1' }] });
    }
    const bin = makeTar([{ name: 'payload', type: 'A', data: PNG }]);
    expect((await scanFile(fixture('type-bin.tar', bin))).verdict).toBe('not_scanned');
    // A link or directory with no data is still clean.
    const plain = makeTar([{ name: 'd/', type: '5' }, { name: 'd/l', type: '2' }, { name: 'd/a.txt', data: 'hi\n' }]);
    expect(await scanFile(fixture('types-ok.tar', plain))).toEqual({ verdict: 'clean', findings: [] });
  });

  it('frames a member by its pax size record, not the header size field', async () => {
    const body = Buffer.from(`one\n${FAKE.aws}\n`);
    // The header says no data; the pax record gives the real size.
    const tar = Buffer.concat([
      tarHeader('PaxHeader', paxData({ size: body.length }).length, 'x'), pad512(paxData({ size: body.length })),
      tarHeader('keys.txt', 0), pad512(body),
      Buffer.alloc(1024),
    ]);
    expect(await scanFile(fixture('pax-size.tar', tar)))
      .toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 'keys.txt:2' }] });
  });

  it('a pax header whose size cannot be followed makes it not_scanned', async () => {
    const withPax = (records, type = 'x') => Buffer.concat([
      tarHeader('PaxHeader', paxData(records).length, type), pad512(paxData(records)),
      tarHeader('a.txt', 6), pad512(Buffer.from('hello\n')),
      Buffer.alloc(1024),
    ]);
    expect((await scanFile(fixture('pax-path.tar', withPax({ path: 'b.txt' })))).verdict).toBe('clean');
    expect((await scanFile(fixture('pax-bad.tar', withPax({ size: '12abc' })))).verdict).toBe('not_scanned');
    expect((await scanFile(fixture('pax-global.tar', withPax({ size: 6 }, 'g')))).verdict).toBe('not_scanned');
    expect((await scanFile(fixture('pax-long.tar', withPax({ comment: 'x'.repeat(70 * 1024), size: 6 })))).verdict).toBe('not_scanned');
    const garbled = Buffer.concat([Buffer.from('9999 size=6\n'), Buffer.from('hello')]);
    const tar = Buffer.concat([
      tarHeader('PaxHeader', garbled.length, 'x'), pad512(garbled),
      tarHeader('a.txt', 6), pad512(Buffer.from('hello\n')),
      Buffer.alloc(1024),
    ]);
    expect((await scanFile(fixture('pax-garbled.tar', tar))).verdict).toBe('not_scanned');
    // A record must end in the newline its length counts.
    const unterminated = Buffer.from('9 path=xX');
    const tar2 = Buffer.concat([
      tarHeader('PaxHeader', unterminated.length, 'x'), pad512(unterminated),
      tarHeader('a.txt', 6), pad512(Buffer.from('hello\n')),
      Buffer.alloc(1024),
    ]);
    expect((await scanFile(fixture('pax-unterminated.tar', tar2))).verdict).toBe('not_scanned');
  });

  it('a corrupt or truncated tar is not_scanned', async () => {
    const good = makeTar([{ name: 'a.txt', data: 'hello world\n'.repeat(100) }]);
    expect((await scanFile(fixture('trunc.tar', good.subarray(0, 700)))).verdict).toBe('not_scanned');
    expect((await scanFile(fixture('junk.tar', Buffer.alloc(2048, 0x41)))).verdict).toBe('not_scanned');
  });
});

describe('scanFile: zip', () => {
  it('flags a JWT inside a deflated member with member:line', async () => {
    const zip = makeZip([
      { name: 'notes/readme.txt', data: `hello\nalice\nauth: Bearer ${FAKE.jwt}\n` },
    ]);
    const r = await scanFile(fixture('docs.zip', zip));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'jwt', line: 'notes/readme.txt:3' }] });
    expect(JSON.stringify(r)).not.toContain(FAKE.jwt);
  });

  it('scans stored members too', async () => {
    const zip = makeZip([{ name: 'a.txt', data: `k=${FAKE.aws}\n`, method: 0 }]);
    expect((await scanFile(fixture('stored.zip', zip))).findings).toEqual([{ kind: 'aws_access_key', line: 'a.txt:1' }]);
  });

  it('flags sensitive member names', async () => {
    const zip = makeZip([{ name: 'keys/server.pem', data: 'nothing\n' }]);
    expect((await scanFile(fixture('k.zip', zip))).findings).toEqual([{ kind: 'sensitive_file', line: 'keys/server.pem' }]);
  });

  it('clean zip is clean; an unsupported method member makes it not_scanned', async () => {
    expect(await scanFile(fixture('ok.zip', makeZip([{ name: 'a.txt', data: 'hi\n' }, { name: 'd/', data: '', method: 0 }]))))
      .toEqual({ verdict: 'clean', findings: [] });
    const bz = makeZip([{ name: 'a.txt', data: 'hi\n' }, { name: 'b.txt', data: 'raw', method: 0 }]);
    // Rewrite the second member's method to 12 (bzip2) in its central entry.
    const cdStart = bz.readUInt32LE(bz.length - 22 + 16);
    const secondCentral = cdStart + 46 + 'a.txt'.length;
    bz.writeUInt16LE(12, secondCentral + 10);
    expect((await scanFile(fixture('bz.zip', bz))).verdict).toBe('not_scanned');
  });

  it('scans an entry named like a directory that carries data', async () => {
    for (const method of [0, 8]) {
      const zip = makeZip([{ name: 'a.txt', data: 'hi\n' }, { name: 'd/', data: `k=${FAKE.aws}\n`, method }]);
      expect(await scanFile(fixture(`dirdata-${method}.zip`, zip)))
        .toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 'd/:1' }] });
    }
    const bin = makeZip([{ name: 'd/', data: PNG, method: 0 }]);
    expect((await scanFile(fixture('dirbin.zip', bin))).verdict).toBe('not_scanned');
  });

  it('a skipped member does not hide a finding in another', async () => {
    const bz = makeZip([{ name: 'a.txt', data: `${FAKE.aws}\n` }, { name: 'b.txt', data: 'raw', method: 0 }]);
    const cdStart = bz.readUInt32LE(bz.length - 22 + 16);
    bz.writeUInt16LE(12, cdStart + 46 + 'a.txt'.length + 10);
    expect((await scanFile(fixture('bz2.zip', bz))).verdict).toBe('flagged');
  });

  it('data appended after the end record makes it not_scanned (cat secret >> archive)', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello\n' }]);
    expect((await scanFile(fixture('tail0.zip', zip))).verdict).toBe('clean');
    expect((await scanFile(fixture('tail.zip', Buffer.concat([zip, Buffer.from(`${FAKE.aws}\n`)])))).verdict).toBe('not_scanned');
    // Findings in the members still stand.
    const dirty = makeZip([{ name: 'k.txt', data: `${FAKE.aws}\n` }]);
    expect(await scanFile(fixture('tail2.zip', Buffer.concat([dirty, Buffer.from('junk')]))))
      .toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 'k.txt:1' }] });
  });

  it('bytes hidden between members, or before the first, make it not_scanned', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello\n', method: 0 }, { name: 'b.txt', data: 'world\n', method: 0 }]);
    // Shrink a.txt's declared size in its central entry: its last bytes are
    // then outside every member's span.
    const cdStart = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt32LE(3, cdStart + 20);
    zip.writeUInt32LE(3, cdStart + 24);
    expect((await scanFile(fixture('gap.zip', zip))).verdict).toBe('not_scanned');
    // A prefix (self-extractor stub, or a secret) before the first member.
    const plain = makeZip([{ name: 'a.txt', data: 'hello\n' }]);
    expect((await scanFile(fixture('pre.zip', Buffer.concat([Buffer.from(`${FAKE.aws}\n`), plain])))).verdict).toBe('not_scanned');
  });

  it('a zip comment is allowed, and scanned under a label no member name gives', async () => {
    expect(await scanFile(fixture('c.zip', makeZip([{ name: 'a.txt', data: 'hi\n' }], null, { comment: 'built by ci' }))))
      .toEqual({ verdict: 'clean', findings: [] });
    const r = await scanFile(fixture('c2.zip', makeZip([{ name: 'a.txt', data: 'hi\n' }], null, { comment: `ok\nkey ${FAKE.aws}` })));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: '<zip comment>:2' }] });
    // A member really called that is shown so it cannot pass for the comment.
    const m = await scanFile(fixture('c3.zip', makeZip([{ name: '<zip comment>', data: `${FAKE.aws}\n` }])));
    expect(m.findings).toEqual([{ kind: 'aws_access_key', line: './<zip comment>:1' }]);
  });

  it('scans each entry comment as text', async () => {
    const clean = makeZip([{ name: 'a.txt', data: 'hi\n' }], [{ of: 0, comment: 'just a note' }]);
    expect(await scanFile(fixture('ec.zip', clean))).toEqual({ verdict: 'clean', findings: [] });
    const dirty = makeZip([{ name: 'a.txt', data: 'hi\n' }, { name: 'b.txt', data: 'yo\n' }], [{ of: 0 }, { of: 1, comment: `key ${FAKE.aws}` }]);
    const r = await scanFile(fixture('ec2.zip', dirty));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: '<entry comment: b.txt>:1' }] });
    expect(JSON.stringify(r)).not.toContain(FAKE.aws);
  });

  it('bytes in the central directory past its last entry make it not_scanned', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hi\n' }]);
    const eocdAt = zip.length - 22;
    const junk = Buffer.from(`${FAKE.aws}\n`);
    const out = Buffer.concat([zip.subarray(0, eocdAt), junk, zip.subarray(eocdAt)]);
    out.writeUInt32LE(out.readUInt32LE(out.length - 22 + 12) + junk.length, out.length - 22 + 12);
    expect((await scanFile(fixture('cdtail.zip', out))).verdict).toBe('not_scanned');
  });

  it('members with data descriptors (streaming writers) are covered exactly', async () => {
    for (const descriptor of [true, 'sig']) {
      const zip = makeZip([{ name: 'a.txt', data: 'hello\n', descriptor }, { name: 'b.txt', data: 'world\n', method: 0, descriptor }]);
      expect(await scanFile(fixture(`dd-${descriptor}.zip`, zip))).toEqual({ verdict: 'clean', findings: [] });
      expect((await scanFile(fixture(`dd-${descriptor}-tail.zip`, Buffer.concat([zip, Buffer.from('x')])))).verdict).toBe('not_scanned');
    }
  });

  it('not a zip at all is not_scanned', async () => {
    expect((await scanFile(fixture('fake.zip', 'hello'))).verdict).toBe('not_scanned');
  });

  it('a bomb of central entries sharing one member is not_scanned without inflating it', async () => {
    const big = 'just some ordinary text here\n'.repeat(1 << 20); // 29 MiB, deflates to ~100 KiB
    const zip = makeZip([{ name: 'a.txt', data: big }], Array.from({ length: 10 }, (_, i) => ({ of: 0, name: `m${i}.txt` })));
    const t = Date.now();
    expect(await scanFile(fixture('bomb.zip', zip))).toEqual({ verdict: 'not_scanned', findings: [] });
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('a repeated local header offset stops the scan there, keeping earlier findings', async () => {
    const zip = makeZip(
      [{ name: 'k.txt', data: `${FAKE.aws}\n` }, { name: 'b.txt', data: 'hello\n' }, { name: 'c.txt', data: `${FAKE.slack}\n` }],
      [{ of: 0 }, { of: 1 }, { of: 1, name: 'b2.txt' }, { of: 2 }],
    );
    expect(await scanFile(fixture('rep.zip', zip))).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 'k.txt:1' }] });
    const clean = makeZip([{ name: 'a.txt', data: 'hi\n' }], [{ of: 0 }, { of: 0, name: 'b.txt' }]);
    expect((await scanFile(fixture('rep2.zip', clean))).verdict).toBe('not_scanned');
  });

  it('a member whose header sits inside another member\'s data is not_scanned', async () => {
    // The stored entry d/ carries a valid local header for b.txt in its
    // data, and the central entry for b.txt points there. (d/ is skipped as
    // a directory, so only the overlap check stops b.txt reading clean.)
    const inner = makeZip([{ name: 'b.txt', data: 'hello\n', method: 0 }]).subarray(0, 30 + 5 + 6);
    const zip = makeZip(
      [{ name: 'd/', data: inner, method: 0 }, { name: 'b.txt', data: 'hello\n', method: 0 }],
      [{ of: 0 }, { of: 1, offset: 30 + 2 }],
    );
    expect((await scanFile(fixture('ovl.zip', zip))).verdict).toBe('not_scanned');
    const entries = await readZipEntries(fixture('ovl2.zip', zip));
    expect([...overlappingEntries(entries)].map((e) => e.name).sort()).toEqual(['b.txt', 'd/']);
    const fine = await readZipEntries(fixture('fine.zip', makeZip([{ name: 'a.txt', data: 'a' }, { name: 'b.txt', data: 'b' }])));
    expect(overlappingEntries(fine).size).toBe(0);
  });

  it('caps the total inflated bytes: not_scanned past it, earlier findings kept', async () => {
    const filler = 'ok\n'.repeat(100000); // 300 KB
    const limits = { maxInflatedBytes: 64 * 1024 };
    const clean = makeZip([{ name: 'a.txt', data: filler }, { name: 'b.txt', data: filler }]);
    expect(await scanFile(fixture('cap.zip', clean), { limits })).toEqual({ verdict: 'not_scanned', findings: [] });
    const dirty = makeZip([{ name: 'a.txt', data: `${FAKE.aws}\n` + filler }]);
    expect(await scanFile(fixture('cap2.zip', dirty), { limits }))
      .toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 'a.txt:1' }] });
    expect(await scanFile(fixture('cap3.zip', clean), { limits: { maxInflatedBytes: 1 << 20 } }))
      .toEqual({ verdict: 'clean', findings: [] });
  });

  it('stops inflating a member once it is seen to be binary', async () => {
    // 4 MiB binary then a text member with a secret, under a 1 MiB inflate
    // cap: only reading a little of the binary leaves room for the secret.
    const bin = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < bin.length; i += 4) bin.writeUInt32LE((i * 2654435761) >>> 0, i);
    const zip = makeZip([{ name: 'blob.bin', data: bin }, { name: 'z.txt', data: `${FAKE.aws}\n` }]);
    expect(await scanFile(fixture('binfirst.zip', zip), { limits: { maxInflatedBytes: 1 << 20 } }))
      .toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 'z.txt:1' }] });
  });

  it('cuts long member names in findings to 256 characters', async () => {
    const name = 'd/'.repeat(300) + 'server.pem';
    const r = await scanFile(fixture('ln.zip', makeZip([{ name, data: `${FAKE.aws}\n` }])));
    expect(r.verdict).toBe('flagged');
    expect(r.findings).toEqual([
      { kind: 'sensitive_file', line: name.slice(0, 256) },
      { kind: 'aws_access_key', line: `${name.slice(0, 256)}:1` },
    ]);
  });

  it('refuses more entries than the cap', async () => {
    expect(ZIP_MAX_ENTRIES).toBe(100000);
    const zip = makeZip([{ name: 'a.txt', data: 'a' }, { name: 'b.txt', data: 'b' }, { name: 'c.txt', data: 'c' }]);
    const p = fixture('many.zip', zip);
    await expect(readZipEntries(p, { maxEntries: 2 })).rejects.toThrow(/too many members/);
    expect((await scanFile(p, { limits: { maxZipEntries: 2 } })).verdict).toBe('not_scanned');
    expect((await scanFile(p, { limits: { maxZipEntries: 3 } })).verdict).toBe('clean');
  });
});

describe('scan errors', () => {
  it('an unexpected error is not_scanned and logged by its code, never the content', async () => {
    const log = { warn: vi.fn() };
    const p = fixture('bad2.gz', Buffer.concat([zlib.gzipSync('ok\n'), Buffer.from(`${FAKE.aws}\n`)]));
    expect((await scanFile(p, { log })).verdict).toBe('not_scanned');
    const warned = log.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(warned).toMatch(/Z_DATA_ERROR/);
    expect(warned).not.toContain(FAKE.aws);
  });

  it('logs a zip member that fails to inflate', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello hello hello\n' }]);
    // Corrupt the deflate stream of the only member.
    zip[30 + 'a.txt'.length] = 0xff;
    zip[30 + 'a.txt'.length + 1] = 0xff;
    const log = { warn: vi.fn() };
    expect((await scanFile(fixture('inflate.zip', zip), { log })).verdict).toBe('not_scanned');
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/Z_DATA_ERROR/));
  });
});

describe('inflate cap', () => {
  it('is 20x the file size, at least 256 MiB and at most 10 GiB', () => {
    const MiB = 1024 * 1024;
    expect(inflateCapFor(0)).toBe(256 * MiB);
    expect(inflateCapFor(10 * MiB)).toBe(256 * MiB);
    expect(inflateCapFor(100 * MiB)).toBe(2000 * MiB);
    expect(inflateCapFor(1024 * MiB)).toBe(10 * 1024 * MiB);
  });

  it('applies to gzip and tgz', async () => {
    const limits = { maxInflatedBytes: 64 * 1024 };
    const filler = 'ok\n'.repeat(100000);
    expect(await scanFile(fixture('cap.txt.gz', zlib.gzipSync(filler)), { limits })).toEqual({ verdict: 'not_scanned', findings: [] });
    expect(await scanFile(fixture('cap.tgz', zlib.gzipSync(makeTar([{ name: 'a.txt', data: filler }]))), { limits }))
      .toEqual({ verdict: 'not_scanned', findings: [] });
    expect(await scanFile(fixture('cap2.tgz', zlib.gzipSync(makeTar([{ name: 'a.txt', data: `${FAKE.aws}\n` + filler }]))), { limits }))
      .toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 'a.txt:1' }] });
  });
});

describe('readZipEntries', () => {
  it('lists members from the central directory', async () => {
    const p = fixture('l.zip', makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'b/c.txt', data: 'x', method: 0 }]));
    const entries = await readZipEntries(p);
    expect(entries.map((e) => [e.name, e.method, e.uncompressedSize])).toEqual([['a.txt', 8, 5], ['b/c.txt', 0, 1]]);
    expect(ZIP_MEMBER_MAX_BYTES).toBe(256 * 1024 * 1024);
  });
});
