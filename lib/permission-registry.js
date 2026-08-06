export const PERMISSION_DECISION_MAX_BODY_BYTES = 64 * 1024;

export function auditPermissionDecision({
  session_id,
  tool_use_id,
  seq,
  tool_name,
  decision,
  source,
  reason,
}, log = console.log) {
  log(JSON.stringify({
    event: 'permission_decision',
    session_id: session_id ?? null,
    tool_use_id: tool_use_id ?? null,
    seq: seq ?? null,
    tool_name: tool_name ?? null,
    decision,
    source,
    reason: reason ?? '',
    ts: new Date().toISOString(),
  }));
}

export function createPermissionDecisionBodyCollector({
  res,
  auditPermissionDecisionFn,
  maxBytes = PERMISSION_DECISION_MAX_BODY_BYTES,
}) {
  let body = '';
  let bodyBytes = 0;
  let tooLarge = false;

  return {
    append(chunk) {
      if (tooLarge) return;
      bodyBytes += chunk.length;
      if (bodyBytes > maxBytes) {
        tooLarge = true;
        body = '';
        const reason = 'request too large';
        auditPermissionDecisionFn({
          session_id: null,
          tool_use_id: null,
          seq: null,
          tool_name: null,
          decision: 'deny',
          source: 'error',
          reason,
        });
        if (!res.writableEnded) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ decision: 'deny', reason }));
        }
        return;
      }
      body += chunk;
    },
    get body() {
      return body;
    },
    get tooLarge() {
      return tooLarge;
    },
  };
}

export function handlePermissionDecisionRoute({
  body,
  data,
  res,
  sessions,
  pendingPermissionDecisions,
  classifyPermissionFn,
  journalConvoIdForFn,
  evictPermissionSeq,
  auditPermissionDecisionFn,
  timeoutMs,
}) {
  const reply = (status, payload) => {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  let parsedData = data;
  if (body !== undefined) {
    try {
      parsedData = JSON.parse(body);
    } catch {
      const reason = 'invalid json';
      auditPermissionDecisionFn({
        session_id: null,
        tool_use_id: null,
        seq: null,
        tool_name: null,
        decision: 'deny',
        source: 'error',
        reason,
      });
      reply(400, { decision: 'deny', reason });
      return;
    }
  }

  const requestData = parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)
    ? parsedData
    : {};
  const { session_id, tool_use_id, tool_name } = requestData;
  const audit = ({ seq = null, decision = 'deny', source, reason = '' }) => {
    auditPermissionDecisionFn({
      session_id,
      tool_use_id,
      seq,
      tool_name,
      decision,
      source,
      reason,
    });
  };

  if (typeof tool_use_id !== 'string' || tool_use_id.trim() === '') {
    const reason = 'tool_use_id required';
    audit({ source: 'error', reason });
    reply(400, { decision: 'deny', reason });
    return;
  }

  let target = null;
  if (typeof session_id === 'string') {
    for (const s of sessions.values()) {
      if (s.claudeSessionId === session_id && s.alive) {
        target = s;
        break;
      }
    }
  }
  if (!target) {
    const reason = 'unknown session';
    audit({ source: 'error', reason });
    reply(404, { decision: 'deny', reason });
    return;
  }
  if (typeof target.requestPermissionDecision !== 'function') {
    const reason = 'no permission handler';
    audit({ source: 'error', reason });
    reply(503, { decision: 'deny', reason });
    return;
  }

  const classification = typeof tool_name === 'string'
    ? classifyPermissionFn(target.permissionSnapshot, tool_name)
    : 'default-gated';
  if (classification === 'deny' || classification === 'ask') {
    audit({ source: 'policy-deny', reason: 'policy' });
    reply(200, { decision: 'deny', reason: 'policy' });
    return;
  }
  if (classification === 'allow') {
    audit({ decision: 'allow', source: 'auto-allow' });
    reply(200, { decision: 'allow' });
    return;
  }

  const convoId = journalConvoIdForFn(target);
  const key = convoId + String.fromCharCode(0) + tool_use_id;
  if (pendingPermissionDecisions.has(key)) {
    const reason = 'duplicate pending decision';
    audit({ source: 'error', reason });
    reply(200, { decision: 'deny', reason });
    return;
  }

  const entry = {
    resolve: null,
    timer: null,
    seq: null,
    convoId,
    tool_name,
  };
  const finalize = ({ decision, reason, source }) => {
    if (pendingPermissionDecisions.get(key) !== entry) return;
    clearTimeout(entry.timer);
    pendingPermissionDecisions.delete(key);
    evictPermissionSeq(key, convoId);
    audit({ seq: entry.seq, decision, source, reason });
    reply(200, { decision, reason: reason || '' });
  };
  entry.resolve = finalize;
  entry.timer = setTimeout(() => {
    finalize({ decision: 'deny', reason: 'timeout', source: 'timeout' });
  }, timeoutMs);
  pendingPermissionDecisions.set(key, entry);
  res.on('close', () => {
    if (!res.writableEnded) {
      finalize({ decision: 'deny', reason: 'client disconnect', source: 'disconnect' });
    }
  });

  try {
    target.requestPermissionDecision(tool_use_id, { tool_name });
  } catch (error) {
    finalize({
      decision: 'deny',
      reason: `session handler threw: ${error?.message || error}`,
      source: 'error',
    });
  }
}

export function createPermissionSeams({ pendingPermissionDecisions }) {
  function notePermissionSeq(key, seq, convoId) {
    const pending = pendingPermissionDecisions.get(key);
    if (pending?.convoId === convoId && pending.seq === null) pending.seq = seq;
  }

  function resolvePermissionReply(key, decision) {
    const pending = pendingPermissionDecisions.get(key);
    if (typeof pending?.resolve === 'function') pending.resolve({ decision, source: 'operator' });
  }

  function hasLivePermissionPending(convoId) {
    for (const pending of pendingPermissionDecisions.values()) {
      if (pending?.convoId === convoId && pending.seq === null) return true;
    }
    return false;
  }

  function isLivePendingToolUse(key, convoId) {
    const pending = pendingPermissionDecisions.get(key);
    return !!pending && pending.convoId === convoId;
  }

  return {
    notePermissionSeq,
    resolvePermissionReply,
    hasLivePermissionPending,
    isLivePendingToolUse,
  };
}
