import { randomUUID } from 'node:crypto';

export const PERMISSION_DECISION_MAX_BODY_BYTES = 64 * 1024;
export const PERMISSION_MAX_PENDING_PER_CONVO = 32;
export const PERMISSION_MAX_PENDING_GLOBAL = 512;
const PERMISSION_TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PERMISSION_TOOL_NAME = /^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/;

export function buildPermissionCardPayload(toolUseId, toolName, expiresAt, nonce) {
  const match = typeof toolName === 'string'
    ? toolName.match(/^mcp__([A-Za-z0-9_.-]+)__([A-Za-z0-9_.-]+)$/)
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
    nonce,
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
    const key = buildPermissionKey(convoId, toolUseId);
    const pending = pendingPermissionDecisions.get(key);
    const nonce = randomUUID();
    if (pending) pending.nonce = nonce;
    const payload = buildPermissionCardPayload(toolUseId, tool_name, exp, nonce);
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
  principal,
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
    principal: principal ?? null,
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
  permissionToken,
}) {
  const reply = (status, payload) => {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (!process.env.MATRON_PERMISSION_CARDS) {
    const reason = 'feature disabled';
    auditPermissionDecisionFn({
      session_id: null,
      tool_use_id: null,
      seq: null,
      tool_name: null,
      decision: 'deny',
      source: 'error',
      reason,
    });
    reply(200, { decision: 'deny', reason });
    return;
  }

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
  const { session_id, tool_use_id: requestedToolUseId, tool_name: requestedToolName } = requestData;
  const auditUnauthenticatedRejection = reason => {
    auditPermissionDecisionFn({
      session_id: null,
      tool_use_id: null,
      seq: null,
      tool_name: null,
      decision: 'deny',
      source: 'error',
      reason,
    });
  };

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
    auditUnauthenticatedRejection(reason);
    reply(404, { decision: 'deny', reason });
    return;
  }
  if (typeof permissionToken !== 'string'
    || !permissionToken
    || permissionToken !== target.permissionToken) {
    const reason = 'unauthorized';
    auditUnauthenticatedRejection(reason);
    reply(403, { decision: 'deny', reason });
    return;
  }

  let toolUseId = null;
  let toolName = null;
  if (typeof requestedToolUseId === 'string'
    && PERMISSION_TOOL_USE_ID.test(requestedToolUseId)) {
    toolUseId = requestedToolUseId;
  }
  if (typeof requestedToolName === 'string'
    && requestedToolName.length <= 256
    && PERMISSION_TOOL_NAME.test(requestedToolName)) {
    toolName = requestedToolName;
  }
  const audit = ({
    seq = null,
    decision = 'deny',
    source,
    reason = '',
    principal = null,
  }) => {
    auditPermissionDecisionFn({
      session_id: target.claudeSessionId,
      tool_use_id: toolUseId,
      seq,
      tool_name: toolName,
      decision,
      source,
      reason,
      principal,
    });
  };

  if (requestedToolUseId === undefined || requestedToolUseId === null) {
    const reason = 'tool_use_id required';
    audit({ source: 'error', reason });
    reply(400, { decision: 'deny', reason });
    return;
  }
  if (toolUseId === null) {
    const reason = 'tool_use_id invalid';
    audit({ source: 'error', reason });
    reply(400, { decision: 'deny', reason });
    return;
  }
  if (typeof requestedToolName !== 'string') {
    const reason = 'tool_name required';
    audit({ source: 'error', reason });
    reply(400, { decision: 'deny', reason });
    return;
  }
  if (toolName === null) {
    const reason = 'invalid tool_name';
    audit({ source: 'error', reason });
    reply(400, { decision: 'deny', reason });
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
  const key = buildPermissionKey(convoId, toolUseId);
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
    nonce: null,
  };
  const finalize = ({ decision, reason, source, principal }) => {
    if (pendingPermissionDecisions.get(key) !== entry) return false;
    clearTimeout(entry.timer);
    pendingPermissionDecisions.delete(key);
    evictPermissionSeq(key, convoId);
    audit({ seq: entry.seq, decision, source, reason, principal });
    reply(200, { decision, reason: reason || '' });
    return { decision, source };
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
    target.requestPermissionDecision(toolUseId, {
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
    if (pending?.convoId !== convoId || pending.seq !== null) return false;
    pending.seq = seq;
    return true;
  }

  function resolvePermissionReply(key, decision, { username } = {}) {
    const pending = pendingPermissionDecisions.get(key);
    if (typeof pending?.resolve !== 'function') return false;
    if (typeof pending.expiresAt === 'number' && Date.now() >= pending.expiresAt) {
      return pending.resolve({ decision: 'deny', reason: 'timeout', source: 'timeout' });
    }
    return pending.resolve({ decision, source: 'operator', principal: username });
  }

  function hasLivePermissionPending(convoId) {
    for (const pending of pendingPermissionDecisions.values()) {
      if (pending?.convoId === convoId && pending.seq === null) return true;
    }
    return false;
  }

  function isLivePendingToolUse(key, convoId, nonce) {
    const pending = pendingPermissionDecisions.get(key);
    return typeof nonce === 'string'
      && !!pending
      && pending.convoId === convoId
      && pending.nonce === nonce;
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
