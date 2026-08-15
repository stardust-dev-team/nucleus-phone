// jsec-kh7h / jsec-7jjy: hand supertest an already-listening server bound to the IPv4 loopback.
//
// WHY THIS EXISTS (do not "simplify" it back to request(expressApp)):
//
// supertest calls a bare app.listen(0) for EVERY request (supertest/lib/test.js:63). A bare
// listen(0) binds "::" — the IPv6 WILDCARD — while supertest then builds its URL as
// http://127.0.0.1:<port>, an IPv4 address. Those are different address families, and the
// kernel's IPv6 ephemeral-port allocator does not consult the IPv4 table: it will hand back a
// port that an IPv4 listener in ANOTHER PROCESS already owns, with no EADDRINUSE. Loopback then
// delivers the request to that foreign listener, not to our app.
//
// Measured on macOS 25.6 / Node 22 (60,000 binds against 40 held 127.0.0.1 ports):
//     bare listen(0)          -> 120 collisions
//     listen(0, "127.0.0.1")  ->   0 collisions
//
// The symptom depends entirely on WHO squatted the port, so one defect wears three masks:
//   - another HTTP service      -> a spurious 401/403/400 on a request that was perfectly valid
//   - any non-HTTP listener     -> "Parse Error: Expected HTTP/, RTSP/ or ICE/"
//   - one that closes on connect-> "socket hang up" / ECONNRESET
// Root-caused and fixed in joruva-security (jsec-7jjy, PR #52); ported here under jsec-kh7h.
const { once } = require('node:events');

const servers = [];

/**
 * Listen on 127.0.0.1:0 and return the Server. Pass the RESULT to supertest's request():
 * because Server.address() is then non-null, supertest skips its own listen/close entirely.
 *
 * ASYNC ON PURPOSE — do not "simplify" it to a synchronous return. listen(port) binds
 * synchronously, but listen(port, HOST) defers the bind behind a dns.lookup() of the host, even
 * when the host is a numeric literal. address() is therefore still null when listen() returns,
 * supertest's `if (!addr)` guard fires, and it calls listen(0) on this very server — re-adding
 * the IPv6 wildcard binding this helper exists to avoid. A synchronous version of this function
 * typechecks, passes in isolation, and is a COMPLETE NO-OP.
 */
async function listenLoopback(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return server;
}

/**
 * Close every server handed out since the last call.
 *
 * Wire as `afterEach(closeLoopbackServers)` when each test binds its own server. If a file binds
 * ONE server in `beforeAll`, wire it as `afterAll` instead — an afterEach would close that server
 * after the first test, and every later request() would find address() === null and fall back to
 * supertest's own bare listen(0), silently restoring the hazard this helper exists to prevent.
 */
function closeLoopbackServers() {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
}

module.exports = { listenLoopback, closeLoopbackServers };
