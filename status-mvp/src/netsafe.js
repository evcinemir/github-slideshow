import { lookup } from 'node:dns/promises';
import net from 'node:net';

// Webhook adreslerinin iç ağa (SSRF) yönlenmesini engeller.
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
}

export async function assertPublicUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Geçersiz URL');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new Error('Webhook adresi https:// ile başlamalı');
  if (url.username || url.password) throw new Error('URL içinde kullanıcı bilgisi olamaz');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('Webhook adresi özel/iç bir ağa çözümleniyor');
  return url;
}
