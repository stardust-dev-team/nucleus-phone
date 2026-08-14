// jsec-kh7h / jsec-7jjy TRIPWIRE: fail loudly on any port-0 bind landing on the IPv6 WILDCARD.
//
// A bare listen(0) binds "::". The kernel's IPv6 ephemeral-port allocator does not consult the
// IPv4 table, so it hands back ports that IPv4 listeners in OTHER PROCESSES already own, with no
// EADDRINUSE. Anything that then connects to 127.0.0.1:<port> — which is what supertest builds,
// and what hand-rolled `http://127.0.0.1:${server.address().port}` helpers build too — reaches
// the FOREIGN listener. Measured: 120 collisions per 60,000 bare binds, 0 per 60,000 loopback
// binds. Root cause and fix: joruva-security jsec-7jjy (PR #52).
//
// SCOPE: this patches net.Server.prototype in THIS process. Spawned children are not covered.
// Escape hatch (explicit and greppable): ALLOW_BARE_LISTEN0=1, with a written reason.
const net = require('node:net');

// Verified empirically — do not adjust from memory:
//   listen(0) / listen("0") / listen({port:"0"}) / listen(0,"::")  -> "::"        HAZARD
//   listen(0,"0.0.0.0")  -> IPv4 wildcard, SAFE (same family as the connect)
//   listen(0,"127.0.0.1")-> SAFE
const IPV6_WILDCARD = /^(::|0:0:0:0:0:0:0:0)$/;

/** True when this call binds an OS-assigned port on the IPv6 wildcard. */
const bindsIpv6Wildcard = (args) => {
  const [first, second] = args;
  const hostIsWildcard = (host) =>
    host === undefined || typeof host !== 'string' || IPV6_WILDCARD.test(host);
  if (first === undefined || typeof first === 'function') return typeof second !== 'string';
  if (typeof first === 'object' && first !== null) {
    const o = first;
    if (o.path !== undefined || o.fd !== undefined) return false; // unix socket / inherited fd
    return Number(o.port) === 0 && hostIsWildcard(o.host);
  }
  return Number(first) === 0 && hostIsWildcard(second);
};

const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (bindsIpv6Wildcard(args) && process.env.ALLOW_BARE_LISTEN0 !== '1') {
    throw new Error(
      'jsec-kh7h: this binds port 0 on the IPv6 wildcard, and the kernel can hand you a port an ' +
        'IPv4 listener in another process already owns — the request then goes to THAT process. ' +
        'Name the address you will connect to: listen(0, "127.0.0.1"). For supertest, pass the ' +
        'result of listenLoopback() to request(), never a bare Express app. ' +
        'Set ALLOW_BARE_LISTEN0=1 only with a written reason.',
    );
  }
  // `listen` is overloaded, so Parameters<typeof realListen> would mean the LAST overload only.
  return realListen.apply(this, args);
};

module.exports = { bindsIpv6Wildcard };
