import {createServer} from 'node:http';
import {forwardAddonRequest, isExternalRoute, serviceOrigin} from './addon-endpoints.mjs';

const check = (ok, status, message) => {
  if (!ok) throw Object.assign(new Error(message), {status});
};

// TLS terminates at the operator's HTTPS proxy. The local socket accepts only
// that package's signed routes and its configured public Host header.
export function createAddonListeners(db, addons, portalOrigins) {
  db.exec('CREATE TABLE IF NOT EXISTS addon_listener_settings (id TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL, origin TEXT NOT NULL UNIQUE)');
  const settings = id => db.prepare('SELECT host,port,origin FROM addon_listener_settings WHERE id=?').get(id);
  const running = new Map();
  const changing = new Set();
  let closed = false;

  function status(id) {
    return {...(settings(id) ?? {host:'127.0.0.1', port:4181, origin:''}), running:running.get(id)?.server.listening === true};
  }
  async function stop(id) {
    const active = running.get(id);
    if (!active) return;
    running.delete(id);
    await new Promise(resolve => {
      active.server.close(resolve);
      active.server.closeAllConnections();
    });
  }
  function routeServer(id, config, service) {
    const server = createServer(async (req, res) => {
      res.setHeader('Cache-Control','no-store');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Referrer-Policy','no-referrer');
      try {
        const path = req.url.split('?', 1)[0];
        check(req.headers.host === new URL(config.origin).host && isExternalRoute(path), 404, 'Endpoint unavailable.');
        const dispatch = addons.listenerRoute(id, path, service);
        check(running.get(id)?.server === server && dispatch, 404, 'Endpoint unavailable.');
        await forwardAddonRequest(req, res, dispatch);
      } catch (error) {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(error.status || 400, {'content-type':'application/json'});
          res.end(JSON.stringify({error:error.message}));
        }
      }
    });
    server.headersTimeout = 15_000;
    server.requestTimeout = 45_000;
    return server;
  }
  async function change(input, authorize) {
    const {id, action} = input;
    const owner = authorize();
    const service = addons.listenerService(id, owner);
    check(service, 403, 'An active licensed endpoint and its approving owner are required.');
    check(!closed && !changing.has(id), 409, 'Another listener operation is in progress.');
    const keys = action === 'configure' ? ['id','action','host','port','origin'] : ['id','action'];
    check(['configure','start','stop'].includes(action) && Object.keys(input).length === keys.length &&
      keys.every(key => Object.hasOwn(input,key)), 400, 'Invalid listener operation.');
    changing.add(id);
    try {
      if (action === 'configure') {
        check(!running.has(id), 409, 'Stop the listener before changing its address.');
        const {host,port,origin} = input;
        check(['127.0.0.1','::1'].includes(host) && Number.isInteger(port) && port >= 1 && port <= 65535,
          400, 'Choose a loopback bind address and a TCP port from 1 to 65535.');
        check(serviceOrigin(origin) && !portalOrigins.includes(origin), 400, 'Use a dedicated HTTPS origin for this endpoint.');
        const occupied = db.prepare('SELECT id FROM addon_listener_settings WHERE origin=? AND id<>?').get(origin,id);
        check(!occupied, 409, 'Another package uses this HTTPS origin.');
        db.prepare('INSERT INTO addon_listener_settings(id,host,port,origin) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET host=excluded.host,port=excluded.port,origin=excluded.origin').run(id,host,port,origin);
      } else if (action === 'stop') {
        await stop(id);
      } else if (!running.has(id)) {
        const config = settings(id);
        check(config, 400, 'Save the endpoint address before starting.');
        const server = routeServer(id, config, service);
        try {
          await new Promise((resolve,reject) => {
            server.once('error',reject);
            server.listen(config.port,config.host,resolve);
          });
          check(!closed && addons.listenerService(id,authorize()) === service, 403, 'Service authorization changed.');
          running.set(id, {server,service});
        } catch (error) {
          server.close();
          if (error.code === 'EADDRINUSE') throw Object.assign(new Error('This listen address is already in use.'), {status:409});
          throw error;
        }
      }
      return status(id);
    } finally { changing.delete(id); }
  }
  async function reconcile() {
    await Promise.all([...running].filter(([id,active]) => addons.listenerService(id) !== active.service).map(([id]) => stop(id)));
  }
  const timer = setInterval(() => void reconcile(),1000);
  timer.unref();
  return {status,change,reconcile,async remove(id) {
    await stop(id);
    db.prepare('DELETE FROM addon_listener_settings WHERE id=?').run(id);
  },async close() {
    closed = true;
    clearInterval(timer);
    await Promise.all([...running.keys()].map(stop));
  }};
}
