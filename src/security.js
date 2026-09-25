import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0']);

export function isPrivateIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local, covers 169.254.169.254 cloud metadata
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower.startsWith('ff')) return true;
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice(7);
      if (net.isIP(tail) === 4) return isPrivateIp(tail);
      const words = tail.split(':');
      if (words.length !== 2) return true;
      const value = words.map((word) => parseInt(word, 16));
      return isPrivateIp([value[0] >> 8, value[0] & 255, value[1] >> 8, value[1] & 255].join('.'));
    }
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (/^fe[89ab]/.test(lower)) return true; // link-local /10
    return false;
  }
  return true; // couldn't determine -> block to be safe
}

/**
 * Throws if the URL is unsafe to fetch (wrong protocol, blocked hostname,
 * or resolves to a private/internal/cloud-metadata IP). Call this before
 * every outbound fetch, including on every redirect hop.
 */
export async function assertSafeUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Blocked protocol: ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked hostname: ${hostname}`);
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Blocked private/internal IP: ${hostname}`);
    return url;
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error(`DNS lookup failed for ${hostname}: ${e.message}`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`Blocked: ${hostname} resolves to internal/private IP ${address}`);
    }
  }
  return url;
}
