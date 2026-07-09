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
