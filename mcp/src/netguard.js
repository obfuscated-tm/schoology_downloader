// Refuses to fetch loopback, private, link-local, CGNAT, and IPv6 ULA /
// link-local addresses. Used by fetch_page before making any request, and
// re-checked on every redirect hop. Resolution is injectable so tests can
// exercise real DNS-backed hosts (or fake ones) without touching the network
// stack's real resolver.
import dns from "node:dns";
import net from "node:net";

export class AddressBlockedError extends Error {
  constructor(host, address) {
    super(`refusing to fetch ${host} (resolves to ${address}, a non-public address)`);
    this.name = "AddressBlockedError";
    this.host = host;
    this.address = address;
  }
}

function isBlockedIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

function isBlockedIPv6(ip) {
  const norm = ip.toLowerCase();
  if (norm === "::1" || norm === "::") return true; // loopback / unspecified
  const v4mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isBlockedIPv4(v4mapped[1]); // IPv4-mapped address

  const firstGroup = norm.split(":")[0];
  if (!firstGroup) return false; // starts with "::" but isn't ::1 or :: — leave to other checks
  const val = parseInt(firstGroup, 16);
  if (Number.isNaN(val)) return false;
  if ((val & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((val & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  return false;
}

/** True if `ip` (v4 or v6, as returned by dns.lookup) is not a public address. */
export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true; // unrecognized shape: refuse
}

/**
 * Resolve `hostname` and throw AddressBlockedError if it (or any of its
 * resolved addresses) is not public. `lookup` is injectable for tests;
 * defaults to Node's real DNS resolution with `{ all: true }`.
 */
export async function assertPublicHost(hostname, { lookup } = {}) {
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new AddressBlockedError(hostname, hostname);
    return;
  }
  const doLookup =
    lookup ||
    ((host, opts) => new Promise((resolve, reject) => dns.lookup(host, opts, (err, addrs) => (err ? reject(err) : resolve(addrs)))));

  const addrs = await doLookup(hostname, { all: true });
  if (!addrs || addrs.length === 0) throw new Error(`could not resolve host ${hostname}`);
  for (const entry of addrs) {
    const address = typeof entry === "string" ? entry : entry.address;
    if (isBlockedAddress(address)) throw new AddressBlockedError(hostname, address);
  }
}
