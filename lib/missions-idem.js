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
