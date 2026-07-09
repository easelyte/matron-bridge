import { mergeContentBlockGroups } from './message-coalescer.js';

export async function downloadAndMerge(entries, session, deps) {
  const { buildMediaContentBlocks, sendTranscribeNotice, editNotice, reportFailure } = deps;
  const groups = [];

  for (const { event, meta } of entries) {
    if (meta.msgtype === 'm.text' || meta.msgtype === 'm.notice') {
      groups.push([{ type: 'text', text: event.content.body || '' }]);
      continue;
    }

    let noticeId = null;
    if (meta.msgtype === 'm.audio' && sendTranscribeNotice) noticeId = await sendTranscribeNotice();

    try {
      const blocks = await buildMediaContentBlocks(event, session);
      if (!blocks || blocks.length === 0) {
        if (reportFailure) reportFailure(meta.name);
        groups.push([{ type: 'text', text: `[attachment "${meta.name || 'file'}" could not be processed and was omitted]` }]);
        continue;
      }
      if (noticeId && editNotice) editNotice(noticeId, blocks);
      groups.push(blocks);
    } catch (err) {
      if (reportFailure) reportFailure(meta.name, err);
      groups.push([{ type: 'text', text: `[attachment "${meta.name || 'file'}" failed to download and was omitted]` }]);
    }
  }

  return mergeContentBlockGroups(groups);
}
