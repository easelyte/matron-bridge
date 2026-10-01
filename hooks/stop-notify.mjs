#!/usr/bin/env node
// Stop hook (Node port of stop-notify.sh) — tells the bridge an assistant turn
// has finished.
import { readStdinJson, postBridge } from './hook-util.mjs';

const input = await readStdinJson();
const sessionId = typeof input?.session_id === 'string' ? input.session_id : '';
const transcriptPath = typeof input?.transcript_path === 'string' ? input.transcript_path : '';
await postBridge('/turn-end', { session_id: sessionId, transcript_path: transcriptPath }, { timeoutMs: 5000 });
process.exit(0);
