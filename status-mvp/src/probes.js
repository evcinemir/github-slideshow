import { Resolver } from 'node:dns/promises';
import tls from 'node:tls';

const USER_AGENT = 'CoktuMuBot/0.1 (+https://github.com/evcinemir/github-slideshow)';

function errorCode(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'TIMEOUT';
  return err?.cause?.code || err?.code || err?.message || 'ERROR';
}

export async function checkDns(host, { timeoutMs = 5_000, servers } = {}) {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
  if (servers) resolver.setServers(servers);
  const started = performance.now();
  try {
    let addresses;
    try {
      addresses = await resolver.resolve4(host);
    } catch (err) {
      if (err.code !== 'ENODATA') throw err;
      addresses = await resolver.resolve6(host);
    }
    return { ok: addresses.length > 0, ms: Math.round(performance.now() - started), addresses: addresses.slice(0, 4) };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - started), error: errorCode(err) };
  }
}

export function checkTls(host, { port = 443, timeoutMs = 10_000 } = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    const done = (result) => {
      socket.destroy();
      resolve({ ms: Math.round(performance.now() - started), ...result });
    };
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert?.valid_to) return done({ ok: false, error: 'NO_CERT' });
      const validTo = new Date(cert.valid_to);
      const daysLeft = Math.floor((validTo - Date.now()) / 86_400_000);
      const authorized = socket.authorized;
      done({
        ok: authorized && daysLeft >= 0,
        authorized,
        daysLeft,
        validTo: validTo.toISOString(),
        issuer: cert.issuer?.O || cert.issuer?.CN,
        error: authorized ? undefined : String(socket.authorizationError),
      });
    });
    socket.on('timeout', () => done({ ok: false, error: 'TIMEOUT' }));
    socket.on('error', (err) => done({ ok: false, error: errorCode(err) }));
  });
}

// 4xx cevaplar (bot engeli, 403 vb.) "sunucu ayakta" sayılır; yalnızca 5xx, zaman aşımı ve bağlantı hataları başarısızdır.
export async function checkHttp(url, { timeoutMs = 10_000, okStatus = (s) => s < 500 } = {}) {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
    });
    const ms = Math.round(performance.now() - started);
    await res.body?.cancel().catch(() => {});
    return { ok: okStatus(res.status), status: res.status, ms };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - started), error: errorCode(err) };
  }
}

// Tek bir ölçümün sonucu: 'ok' | 'slow' | 'fail'
export function verdictOf({ dns, http, tls: ssl }, { slowMs = 3_000 } = {}) {
  if (!dns.ok || !http.ok) return 'fail';
  if (ssl && !ssl.ok && ssl.error !== 'TIMEOUT') return 'fail';
  if (http.ms > slowMs || (ssl && !ssl.ok)) return 'slow';
  return 'ok';
}

export async function probeService(service, { region, timeoutMs = 10_000, slowMs = 3_000 } = {}) {
  const url = new URL(service.url);
  const host = url.hostname;
  const [dns, http, ssl] = await Promise.all([
    checkDns(host, { timeoutMs: Math.min(timeoutMs, 5_000) }),
    checkHttp(service.url, { timeoutMs }),
    url.protocol === 'https:' ? checkTls(host, { port: Number(url.port) || 443, timeoutMs }) : null,
  ]);
  const result = { t: Date.now(), region, dns, http };
  if (ssl) result.tls = ssl;
  result.verdict = verdictOf(result, { slowMs });
  return result;
}
