export function mergeContentBlockGroups(groups) {
  const merged = [];
  let textAccum = [];
  const flushText = () => {
    if (textAccum.length === 0) return;
    const combined = textAccum
      .map((blocks) => blocks.map((b) => b.text).join('\n'))
      .join('\n\n');
    merged.push({ type: 'text', text: combined });
    textAccum = [];
  };
  for (const blocks of groups) {
    if (blocks.length === 0) continue;
    const isTextOnly = blocks.every((b) => b.type === 'text');
    if (isTextOnly) textAccum.push(blocks);
    else { flushText(); merged.push(...blocks); }
  }
  flushText();
  return merged;
}

export function createCoalesceWindow({ quietMs, hardCapMs, now, setTimer, clearTimer, onFlush }) {
  let entries = [];
  let open = false;
  let startedAt = 0;
  let quietTimer = null;
  let hardCapTimer = null;

  function fire() {
    if (quietTimer !== null) {
      clearTimer(quietTimer);
      quietTimer = null;
    }
    if (hardCapTimer !== null) {
      clearTimer(hardCapTimer);
      hardCapTimer = null;
    }
    const batch = entries;
    entries = [];
    open = false;
    startedAt = 0;
    return batch.length > 0 ? onFlush(batch) : undefined;
  }

  return {
    push(entry) {
      entries.push(entry);
      if (!open) {
        open = true;
        startedAt = now();
        if (hardCapMs <= 0) {
          fire();
          return;
        }
        hardCapTimer = setTimer(fire, hardCapMs);
      }
      if (quietTimer !== null) clearTimer(quietTimer);
      quietTimer = setTimer(fire, quietMs);
    },
    size: () => entries.length,
    startedAt: () => startedAt,
    flush() {
      return fire();
    },
    clear() {
      if (quietTimer !== null) clearTimer(quietTimer);
      if (hardCapTimer !== null) clearTimer(hardCapTimer);
      entries = [];
      open = false;
      startedAt = 0;
      quietTimer = null;
      hardCapTimer = null;
    },
  };
}
