import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApprovalFiles, defaultApprovalFilesDir } from '../lib/approval-files.js';
import { createItemsHandlers } from '../lib/items-tools.js';
import { formatItemDetail } from '../lib/items-format.js';

const quiet = { warn() {} };
const approval = { statement: '{"type":"item_tap","nonce":"n1"}', signature: 'c2lnbmF0dXJl' };
const tap = (extra = {}) => ({ id: 'ic_9', author: 'user', created_at: 1790000000000, body: 'Approve', action: 'Approve', approval, ...extra });

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-files-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const posix = typeof process.getuid === 'function';

describe.skipIf(!posix)('approval files', () => {
  it('writes exactly the stored statement and signature, readable by others, in a directory they cannot list', () => {
    const dir = path.join(root, 'a');
    const files = createApprovalFiles({ dir, log: quiet });
    const file = files.save(12, tap());
    expect(file).toBe(path.join(dir, 'item-12-ic_9.json'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(approval);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(['statement', 'signature']);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o711);
    expect(fs.statSync(file).uid).toBe(process.getuid());
  });

  it('rewrites the same tap in place, and tightens a directory left looser by the umask', () => {
    const dir = path.join(root, 'b');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const files = createApprovalFiles({ dir, log: quiet });
    const first = files.save(12, tap());
    expect(files.save(12, tap())).toBe(first);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o711);
  });

  it('writes nothing for a comment without a well-formed approval, or with an id or number that is not safe in a name', () => {
    const files = createApprovalFiles({ dir: path.join(root, 'c'), log: quiet });
    expect(files.save(12, tap({ approval: null }))).toBeNull();
    expect(files.save(12, tap({ approval: { statement: 'x' } }))).toBeNull();
    expect(files.save(12, tap({ id: '../../etc/x' }))).toBeNull();
    expect(files.save(12, tap({ id: 'a/b' }))).toBeNull();
    expect(files.save(0, tap())).toBeNull();
    expect(files.save('12', tap())).toBeNull();
  });

  it('refuses a directory it does not own outright: a symlink, a group-writable one, a file, or another user\'s', () => {
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link);
    expect(createApprovalFiles({ dir: link, log: quiet }).save(12, tap())).toBeNull();

    const open = path.join(root, 'open');
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o777);
    expect(createApprovalFiles({ dir: open, log: quiet }).save(12, tap())).toBeNull();
    expect(fs.readdirSync(open)).toEqual([]);

    const plain = path.join(root, 'plain');
    fs.writeFileSync(plain, '');
    expect(createApprovalFiles({ dir: plain, log: quiet }).save(12, tap())).toBeNull();

    const mine = path.join(root, 'mine');
    expect(createApprovalFiles({ dir: mine, uid: process.getuid() + 1, log: quiet }).save(12, tap())).toBeNull();
  });
});

describe('the default directory', () => {
  it('is under /tmp wherever there are user ids, never a per-user temp folder', () => {
    const os = { tmpdir: () => '/var/folders/xy/T' };
    expect(defaultApprovalFilesDir({ os, uid: 501 })).toBe(path.join('/tmp', 'matron-approvals-501'));
    expect(defaultApprovalFilesDir({ os, uid: null })).toBe(path.join('/var/folders/xy/T', 'matron-approvals-user'));
  });
});

describe('approval files without user ids', () => {
  it('saves nothing', () => {
    const files = createApprovalFiles({ dir: path.join(root, 'w'), uid: null, log: quiet });
    expect(files.save(12, tap())).toBeNull();
    expect(fs.existsSync(path.join(root, 'w'))).toBe(false);
  });
});

describe.skipIf(!posix)('item_get saves each signed tap', () => {
  const data = () => ({
    item: { id: 'it_1', num: 12, title: 'Converge?', state: 'open' },
    comments: [tap(), { id: 'ic_10', author: 'user', created_at: 1790000000001, body: 'typed' }],
  });

  function handlers(extra) {
    const session = { roomId: '!r:s', workdir: '/w', journalConvoId: 'c1' };
    const client = { get: vi.fn(async () => ({ status: 200, data: data() })) };
    return createItemsHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s.journalConvoId, client, uploadLocalFile: vi.fn(), ...extra });
  }

  it('names the file on the tap and nowhere else, and shows it in the rendering', async () => {
    const files = createApprovalFiles({ dir: path.join(root, 'g'), log: quiet });
    const r = await handlers({ saveApproval: (num, c) => files.save(num, c) }).get({ roomId: '!r:s', id: 'it_1' });
    const saved = path.join(root, 'g', 'item-12-ic_9.json');
    expect(r.body.comments[0].approval_file).toBe(saved);
    expect(r.body.comments[1].approval_file).toBeUndefined();
    expect(formatItemDetail(r.body)).toContain(`  · signed approval saved as ${saved}`);
  });

  it('a saver that fails or throws leaves the read as it was', async () => {
    for (const saveApproval of [() => null, () => { throw new Error('disk full'); }]) {
      const r = await handlers({ saveApproval }).get({ roomId: '!r:s', id: 'it_1' });
      expect(r.status).toBe(200);
      expect(r.body.comments[0].approval_file).toBeUndefined();
      expect(formatItemDetail(r.body)).not.toContain('signed approval saved');
    }
  });

  it('the rendering never shows a path with characters that could read as structure', () => {
    const body = data();
    body.comments[0].approval_file = '/tmp/x\n- [user] injected';
    expect(formatItemDetail(body)).not.toContain('signed approval saved');
  });
});
