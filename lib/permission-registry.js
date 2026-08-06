export const PERMISSION_DECISION_MAX_BODY_BYTES = 64 * 1024;
export const PERMISSION_MAX_PENDING_PER_CONVO = 32;
export const PERMISSION_MAX_PENDING_GLOBAL = 512;

export function buildPermissionCardPayload(toolUseId, toolName, expiresAt) {
  const match = typeof toolName === 'string'
    ? toolName.match(/^mcp__(.+?)__(.+)$/)
    : null;
  const description = match
    ? `Allow ${match[1]} tool "${match[2]}"?`
    : `Allow tool "${toolName}"?`;

  return {
    kind: 'permission',
    tool_use_id: toolUseId,
    description,
    options: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
    ],
    expires_at: expiresAt,
  };
}

export function buildPermissionKey(convoId, toolUseId) {
  return convoId + String.fromCharCode(0) + toolUseId;
}

export function createRequestPermissionDecision(session, {
  journalPublisher,
  pendingPermissionDecisions,
  journalConvoIdFor,
  timeoutMs,
}) {
  return (toolUseId, { tool_name, expires_at } = {}) => {
    const convoId = journalConvoIdFor(session);
    const exp = typeof expires_at === 'number'
      ? expires_at
      : Date.now() + timeoutMs;
    const payload = buildPermissionCardPayload(toolUseId, tool_name, exp);
    // `published` reflects publisher ACCEPTANCE (enqueue): truthy = the frame was
    // queued by a live journal publisher; falsy = no-op/disabled publisher or no
    // convo -> deny immediately. Acceptance is not delivery: under sustained
    // journal-queue overflow an accepted frame can still be evicted before it
    // reaches the operator. That residual is FAIL-CLOSED, not fail-open — the
    // card's true "surfaced" signal is its echo (T-2.3 seq capture); with no echo
    // the seq stays null and the route timer resolves the pending entry deny. No
    // auto-allow can result from a dropped card.
    const published = convoId
      ? journalPublisher.publishPermissionRequest(convoId, payload)
      : false;
    if (convoId && published) return;

    const key = buildPermissionKey(convoId, toolUseId);
    const pending = pendingPermissionDecisions.get(key);
    if (pending?.resolve) {
      pending.resolve({
        decision: 'deny',
        reason: 'no output channel for session',
        source: 'error',
      });
    }
  };
}

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
  const { session_id, tool_use_id, tool_name: requestedToolName } = requestData;
  const toolName = typeof requestedToolName === 'string' ? requestedToolName : null;
  const audit = ({ seq = null, decision = 'deny', source, reason = '' }) => {
    auditPermissionDecisionFn({
      session_id,
      tool_use_id,
      seq,
      tool_name: toolName,
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

  if (toolName === null) {
    const reason = 'tool_name required';
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

  const classification = classifyPermissionFn(target.permissionSnapshot, toolName);
  if (classification === 'deny' || classification === 'ask') {
    audit({ source: 'policy-deny', reason: 'policy' });
    reply(200, { decision: 'deny', reason: 'policy' });
    return;
  }
  if (classification === 'allow') {
    audit({
      decision: 'pass',
      source: 'auto-allow',
      reason: 'passthrough to canonical evaluator',
    });
    reply(200, { decision: 'pass' });
    return;
  }

  const convoId = journalConvoIdForFn(target);
  const keyPrefix = buildPermissionKey(convoId, '');
  const key = buildPermissionKey(convoId, tool_use_id);
  if (pendingPermissionDecisions.has(key)) {
    const reason = 'duplicate pending decision';
    audit({ source: 'error', reason });
    reply(200, { decision: 'deny', reason });
    return;
  }

  let pendingForConvo = 0;
  for (const pendingKey of pendingPermissionDecisions.keys()) {
    if (typeof pendingKey === 'string' && pendingKey.startsWith(keyPrefix)) {
      pendingForConvo += 1;
    }
  }
  if (
    pendingForConvo >= PERMISSION_MAX_PENDING_PER_CONVO
    || pendingPermissionDecisions.size >= PERMISSION_MAX_PENDING_GLOBAL
  ) {
    const reason = 'too many pending decisions';
    audit({ source: 'error', reason });
    reply(200, { decision: 'deny', reason });
    return;
  }

  const entry = {
    resolve: null,
    timer: null,
    expiresAt: null,
    seq: null,
    convoId,
    tool_name: toolName,
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
  const expiresAt = Date.now() + timeoutMs;
  entry.expiresAt = expiresAt;
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
    target.requestPermissionDecision(tool_use_id, {
      tool_name: toolName,
      expires_at: expiresAt,
    });
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

  function finalizePendingPermissionsForConvo(convoId, reason) {
    for (const pending of pendingPermissionDecisions.values()) {
      if (pending?.convoId === convoId && typeof pending.resolve === 'function') {
        pending.resolve({ decision: 'deny', reason, source: 'disconnect' });
      }
    }
  }

  return {
    notePermissionSeq,
    resolvePermissionReply,
    hasLivePermissionPending,
    isLivePendingToolUse,
    finalizePendingPermissionsForConvo,
  };
}
