// Each route is an exact permission in both signed artifacts. Host-owned paths
// never dispatch to packages, including when a future package declares one.
const basePermissions = new Set(['settings', 'service.runtime', 'service.controls', 'network.https',
  'workspace.read', 'workspace.write', 'workspace.write.auto']);
const hostPrefixes = new Set(['api', 'audit', 'kiosk', 'legal', 'shared', 'setup', 'worker', 'main']);
const installerPaths = new Set(['review', 'apply', 'restart', 'settings', 'invoke', 'controls', 'write-policy', 'approve-write','listener','delegation','remove']);
// The main and worker portals use the __Host- prefix for HTTPS sessions.
const portalSessionCookie = /(?:^|;)[ \t]*(?:__Host-)?fq_(?:main|worker)[ \t]*=/;

export function isOwnerRoute(path) {
  const match = /^\/api\/addons\/([a-z][a-z0-9-]{0,63})$/.exec(path);
  return !!match && !installerPaths.has(match[1]);
}

export function isExternalRoute(path) {
  if (typeof path !== 'string' || path.length > 150) return false;
  const pattern = /^\/(?:\.well-known\/)?[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*){0,3}$/;
  return pattern.test(path) && !hostPrefixes.has(path.split('/')[1]);
}

export function validAddonPermissions(values) {
  return Array.isArray(values) && values.length <= 32 && new Set(values).size === values.length &&
    values.every(value => basePermissions.has(value) || (typeof value === 'string' && value.startsWith('route:') &&
      (isExternalRoute(value.slice(6)) || isOwnerRoute(value.slice(6)))));
}

export function serviceOrigin(value) {
  if (value === null) return null;
  let url;
  try { url = new URL(value); } catch {}
  const labels=url?.hostname.split('.')??[];
  requireValue(typeof value === 'string' && url?.origin === value && url.protocol === 'https:' &&
    !url.port && url.hostname.length<=253 && labels.length>=2 &&
    labels.every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    /^[a-z][a-z0-9-]*$/.test(labels.at(-1)), 400, 'Use a canonical HTTPS service hostname.');
  return value;
}

function requireValue(condition, status, message) {
  if (!condition) throw Object.assign(new Error(message), {status});
}

export async function forwardAddonRequest(req, res, dispatch) {
  requireValue(['GET', 'POST'].includes(req.method), 405, 'Method unavailable.');
  requireValue(!portalSessionCookie.test(req.headers.cookie ?? ''), 403, 'Use the separate client connection without portal cookies.');
  requireValue(req.url.length <= 8192, 414, 'Request URL too long.');
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (['host', 'authorization', 'content-type', 'accept', 'origin'].includes(name) || /^[a-z0-9-]{1,32}-protocol-version$/.test(name)) {
      requireValue(typeof value === 'string' && value.length <= 8192, 400, 'Invalid request header.');
      headers[name] = value;
    }
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    requireValue(length <= 64 * 1024, 413, 'Request body too large.');
    chunks.push(chunk);
  }
  const body = new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks));
  const reply = await dispatch({channel:'http', method:req.method, url:req.url, headers, body});
  requireValue(reply && Number.isInteger(reply.status) && reply.status >= 200 && reply.status <= 599 &&
    typeof reply.body === 'string' && Buffer.byteLength(reply.body) <= 512 * 1024, 502, 'Invalid service response.');
  const allowed = {};
  for (const [key, value] of Object.entries(reply.headers ?? {})) {
    const name = key.toLowerCase();
    if (!['allow', 'location', 'www-authenticate', 'content-type', 'retry-after'].includes(name)) continue;
    requireValue(typeof value === 'string' && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value), 502, 'Invalid service header.');
    if (name === 'content-type') {
      requireValue(/^(?:application\/json|text\/(?:plain|html))(?:;\s*charset=utf-8)?$/i.test(value), 502, 'Unsupported service content type.');
    }
    if (name === 'location') {
      const to = new URL(value);
      requireValue(!to.username && !to.password && (to.protocol === 'https:' ||
        (to.protocol === 'http:' && to.hostname === '127.0.0.1' && to.port)), 502, 'Invalid service redirect.');
    }
    allowed[name] = value;
  }
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
  res.writeHead(reply.status, {'content-type':'text/plain; charset=utf-8', ...allowed});
  res.end(reply.body);
}
