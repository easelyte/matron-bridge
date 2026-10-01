#!/usr/bin/env node
// PreCompact hook (Node port of compact-notify.sh) — tells the bridge that
// compaction is starting.
import { readStdinJson, postBridge } from './hook-util.mjs';

const input = await readStdinJson();
const sessionId = typeof input?.session_id === 'string' ? input.session_id : '';
await postBridge('/compact-start', { session_id: sessionId });
process.exit(0);
