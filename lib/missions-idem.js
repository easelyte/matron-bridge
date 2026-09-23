// Idempotency keys for the two POST routes the journal accepts one on
// (spec 2026-09-10, "Idempotency"): POST /missions and POST /milestones.
//
// The key must be the SAME across a retry of the same call and DIFFERENT
// for a genuinely separate post, and the MCP tool layer gets no retry
// identity from the model — so it is derived from the call itself: the
// operation, the room, and the content, inside a ten-minute bucket. A tool
// call the harness retries lands in the same bucket with the same content
// and replays the existing row (a replay is a 200, and the journal emits no
// second transcript marker); the same milestone posted again an hour later
// is a new one. The trade is deliberate and bounded: a retry that straddles
// a bucket boundary duplicates once, and two identical posts inside ten
// minutes collapse into one.
import { createHash } from 'node:crypto';

const BUCKET_MS = 600_000;

export function missionIdemKey({ op, roomId, kind, title, body, now = Date.now() }) {
  const bucket = Math.floor(Number(now) / BUCKET_MS);
  const parts = [op, roomId, kind, title, body].map((v) => (typeof v === 'string' ? v : ''));
  return createHash('sha256').update(`${parts.join('|')}|${bucket}`).digest('hex');
}

// Idempotency key for the two item POST routes that mint/append (loop #763 F2):
// item_create and item_comment. Same derive-from-the-call strategy and ten-minute
// bucket as missionIdemKey — the MCP tool layer gets no retry identity from the
// model, so a harness-retried call lands in the same bucket with the same content
// and replays the existing row (a 200 with no duplicate item/comment and no
// re-notification) instead of minting a second item + re-uploading its blob.
//
// The key must be DISTINCT for any two genuinely-different mutations, or the
// journal's replay would silently return the first row and drop the second's
// fields (orphaning any attachment it uploaded). So it hashes EVERY semantic
// argument, not just kind/title/body: two creates that share a title but differ
// in attachments/labels/links/awaiting/position/supersedes — or two comments that
// differ in attachments/awaiting, or target different items — get different keys.
//
// Encoding is a JSON array (length-safe): field values are quoted/escaped and
// structurally delimited, so distinct tuples like ["a|b","c"] and ["a","b|c"]
// cannot collide the way an unescaped `join('|')` would. Absent fields hash as
// null (distinct from an empty string a caller could pass explicitly).
export function itemIdemKey({ op, roomId, args = {}, now = Date.now() }) {
  const bucket = Math.floor(Number(now) / BUCKET_MS);
  const nn = (v) => (v === undefined ? null : v);
  const canonical = JSON.stringify([
    op, roomId, bucket,
    nn(args.kind), nn(args.title), nn(args.body), nn(args.id),
    nn(args.attachments), nn(args.labels), nn(args.links),
    nn(args.awaiting), nn(args.position), nn(args.supersedes), nn(args.on_behalf_of),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
