// Who may reach the LAN demo: this Mac, and devices on the same subnet as one
// of its interfaces. Anything else (other subnets, anything routed in from
// outside) is refused, so the demo cannot be exposed beyond the local network
// even if a router forwards a port to it.

function toInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return undefined;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * @param {string | undefined} remote socket.remoteAddress (may be IPv4-mapped IPv6)
 * @param {{ address: string, netmask: string }[]} interfaces this Mac's IPv4 interfaces
 */
export function isLanClient(remote, interfaces) {
  if (!remote) return false;
  if (remote === '::1') return true;
  const ip = toInt(remote.startsWith('::ffff:') ? remote.slice(7) : remote);
  if (ip === undefined) return false; // other IPv6: not served
  if (ip >>> 24 === 127) return true;
  return interfaces.some(({ address, netmask }) => {
    const a = toInt(address);
    const m = toInt(netmask);
    return a !== undefined && m !== undefined && (ip & m) >>> 0 === (a & m) >>> 0;
  });
}
