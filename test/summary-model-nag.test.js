import { describe, it, expect, vi } from 'vitest';
import { createSummaryModelNag } from '../lib/summary-model-nag.js';

// A stand-in for the slice of lib/items-client.js the nag uses. Records the
// body and the Idempotency-Key so the dedupe contract is asserted, not
// assumed — the journal collapses reboots by that key alone.
function fakeClient(responses = [{ status: 201, data: { item: { num: 7 } } }]) {
  const calls = [];
  let i = 0;
  return {
    calls,
    create: vi.fn(async (body, opts) => {
      calls.push({ body, opts });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    }),
  };
}

describe('summary-model-nag', () => {
  it('files one task naming the box, awaiting the user', async () => {
    const client = fakeClient();
    const nag = createSummaryModelNag({ client, box: 'greg' });

    await nag.maybeFile('convo-1');

    expect(client.create).toHaveBeenCalledTimes(1);
    const { body, opts } = client.calls[0];
    expect(body.kind).toBe('task');
    expect(body.title).toContain('greg');
    expect(body.awaiting).toBe('user');
    expect(body.convo_id).toBe('convo-1');
    expect(opts.idemKey).toBe('no-summary-model');
  });

  it('files once per process however many turns end', async () => {
    const client = fakeClient();
    const nag = createSummaryModelNag({ client, box: 'greg' });

    await nag.maybeFile('convo-1');
    await nag.maybeFile('convo-2');
    await nag.maybeFile('convo-3');

    expect(client.create).toHaveBeenCalledTimes(1);
  });

  // The latch is on SUCCESS, not on the attempt: a journal that is
  // unreachable at boot (the common case — the bridge starts before the
  // tunnel settles) must not silence the nag for the life of the process.
  it('retries after a failed post, then latches', async () => {
    const client = fakeClient([
      { status: 0, data: { error: 'journal unreachable' } },
      { status: 201, data: { item: { num: 7 } } },
    ]);
    const nag = createSummaryModelNag({ client, box: 'greg' });

    await nag.maybeFile('convo-1');
    await nag.maybeFile('convo-2');
    await nag.maybeFile('convo-3');

    expect(client.create).toHaveBeenCalledTimes(2);
  });

  // An idempotent replay comes back 200 with the item that already exists —
  // including one the user has since closed. That is a success: the nag has
  // been heard, and re-filing it every reboot would be the nagging we are
  // trying not to do.
  it('treats an idempotent replay as filed', async () => {
    const client = fakeClient([{ status: 200, data: { item: { num: 7 } } }]);
    const nag = createSummaryModelNag({ client, box: 'greg' });

    await nag.maybeFile('convo-1');
    await nag.maybeFile('convo-2');

    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it('waits for a conversation to hang the item on', async () => {
    const client = fakeClient();
    const nag = createSummaryModelNag({ client, box: 'greg' });

    await nag.maybeFile(null);
    await nag.maybeFile('');

    expect(client.create).not.toHaveBeenCalled();
  });

  it('does nothing without a journal client', async () => {
    const nag = createSummaryModelNag({ client: null, box: 'greg' });
    await expect(nag.maybeFile('convo-1')).resolves.toBeUndefined();
  });

  // Same stance as every other journal touch in the bridge: a failure here
  // is never allowed to break the turn that triggered it.
  it('swallows a throwing client', async () => {
    const client = { create: vi.fn(async () => { throw new Error('boom'); }) };
    const nag = createSummaryModelNag({ client, box: 'greg' });
    await expect(nag.maybeFile('convo-1')).resolves.toBeUndefined();
  });
});
