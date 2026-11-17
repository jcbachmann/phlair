// Hosts of private networks, which images of pasted HTML are not fetched
// from: the userscript (with "@connect *") and the extension fetch them in
// the browser, which can reach the intranet, and would store them in
// Phorge. The library fetches them on the server, where Phorge's
// "security.outbound-blacklist" keeps out the same networks by default.
// The browser can not look up the address of a name, so this goes by the
// name (intranet names, local domains) and by addresses written as such.

/** IPv4 networks that are not the internet: [first octets, prefix length]. */
const PRIVATE_V4: [number[], number][] = [
  [[0], 8],
  [[10], 8],
  [[100, 64], 10],
  [[127], 8],
  [[169, 254], 16],
  [[172, 16], 12],
  [[192, 168], 16],
];

/** Domains of local networks: mDNS, RFC 8375, and the usual intranet ones. */
const LOCAL_DOMAINS = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/;

function privateV4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  return PRIVATE_V4.some(([start, bits]) => {
    const base = start.reduce((n, octet, i) => n | (octet << (24 - 8 * i)), 0) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  });
}

/**
 * Whether a host (URL.hostname, which writes addresses in one form) is of a
 * private network: loopback, link-local, private and shared addresses, local
 * domains, and names without a dot (intranet hosts).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return privateV4(host);
  }
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    // IPv4 in IPv6 ("::ffff:7f00:1" is 127.0.0.1).
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    if (mapped) {
      const [high, low] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
      return privateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    // Loopback, unspecified, unique local (fc00::/7) and link-local (fe80::/10).
    return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  return !host.includes(".") || LOCAL_DOMAINS.test(host);
}

/** Whether a page may fetch an image of another site: not one of a private network, unless Phorge is on one too. */
export function mayFetchFrom(url: URL, page: Location | URL): boolean {
  return !isPrivateHost(url.hostname) || isPrivateHost(page.hostname);
}
