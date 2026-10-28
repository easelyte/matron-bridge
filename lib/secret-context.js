// Context is public to the request's readers, never a place for the value.
// It also travels in the signed form URL, so keep the explanation bounded.
export const SECRET_CONTEXT_MAX_LENGTH = 2000;

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// An explanation is an agent's claim, not bridge-verified provenance.
// Keep its links literal: a trusted-looking label must not hide a destination
// on the page where the user is being asked to paste a credential.
export function formatSecretContextHtml(context) {
  return typeof context === 'string' ? escapeHtml(context) : '';
}

export function formatSecretContextMarkdown(context) {
  if (typeof context !== 'string') return '';
  // A quoted, escaped explanation cannot supply headings or masked links
  // that appear to be part of the bridge's own request notice.
  return context.replace(/[\\`*_{}[\]()<>!#|~]/g, '\\$&')
    .split(/\r\n|\r|\n/).map((line) => `> ${line}`).join('\n');
}

export function secretConversationUrl(convoId) {
  // IDs come from bridge session state, never a URL supplied by the agent.
  if (typeof convoId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(convoId)) return null;
  return `matron://convo/${convoId}`;
}
