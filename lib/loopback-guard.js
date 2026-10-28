// Requests to the bridge's loopback API come from its own processes: the
// MCP servers, the hooks and the viewer, all of which call 127.0.0.1 (or
// localhost) directly with fetch or curl. A web browser on the same machine
// can also reach a loopback port. A page that points its own hostname at
// 127.0.0.1 (DNS rebinding) becomes same-origin with the API and can read
// its answers. Two cheap checks shut browsers out without touching any
// legitimate caller:
//
//   - the Host header must name a loopback host (a rebound page sends its
//     own hostname);
//   - a request carrying Origin or Sec-Fetch-Site came from a browser, which
//     never has a reason to call this API.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(host) {
  if (typeof host !== 'string' || !host) return null;
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? null : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

// Returns null when the request may proceed, or a short reason when it must
// be refused.
export function loopbackRefusal(headers = {}) {
  if (headers.origin !== undefined) return 'browser origin';
  if (headers['sec-fetch-site'] !== undefined) return 'browser fetch';
  const name = hostnameOf(headers.host);
  if (!name || !LOOPBACK_HOSTS.has(name)) return 'non-loopback host';
  return null;
}
