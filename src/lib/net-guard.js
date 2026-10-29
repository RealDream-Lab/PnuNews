import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Private, loopback, link-local, CGNAT, multicast and otherwise non-public ranges.
function isPrivateIPv4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

export function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) {
    const value = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isPrivateIPv4(mapped[1]);
    return value === '::' || value === '::1' ||
      /^f[cd]/.test(value) ||
      /^fe[89ab]/.test(value) ||
      value.startsWith('ff') ||
      value.startsWith('::ffff:');
  }
  return true;
}

// Cheap synchronous check used when an address is saved: rejects `localhost`-style names and IP literals
// that point into the internal network.
export function isObviouslyInternalHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  return isIP(host) ? isPrivateAddress(host) : false;
}

// Used right before the server fetches an administrator-supplied URL: every address the name
// resolves to must be public, so the server cannot be used to probe the internal network.
export async function resolvesToPublicAddress(hostname, lookupImpl = lookup) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  if (isObviouslyInternalHost(host)) return false;
  if (isIP(host)) return true;
  try {
    const addresses = await lookupImpl(host, { all: true });
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateAddress(address));
  } catch {
    return false;
  }
}

// Reads at most `maxBytes` of a fetch() response body; anything larger is rejected.
export async function readLimitedText(response, maxBytes = 64 * 1024) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Response too large');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Response too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}
