import { resolveUploadMeta } from './iv-uploads.js';

function stripToText(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim() || null;
}

export function resolveMediaCaption(content) {
  const { filename, caption } = resolveUploadMeta(content);
  return { filename, caption: stripToText(content.formatted_body) || caption };
}
