export function createPermissionSeams({ pendingPermissionDecisions }) {
  function notePermissionSeq(key, seq, convoId) {
    const pending = pendingPermissionDecisions.get(key);
    if (pending?.convoId === convoId && pending.seq === null) pending.seq = seq;
  }

  function resolvePermissionReply(key, decision) {
    const pending = pendingPermissionDecisions.get(key);
    if (typeof pending?.resolve === 'function') pending.resolve({ decision });
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
