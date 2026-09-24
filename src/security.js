import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0']);

function isPrivateIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local, covers 169.254.169.254 cloud metadata
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('fe80')) return true; // link-local
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
  const hostname = url.hostname.toLowerCase();
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
