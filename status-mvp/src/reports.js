import { createHash } from 'node:crypto';
import { ISPS, COMPONENT_LABELS } from './catalog.js';

const DEDUPE_MS = 30 * 60_000;

export function hashIp(ip, salt) {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);
}

// "Bende de çalışmıyor" bildirimi. Aynı kişi aynı servis için 30 dakikada bir bildirim yapabilir.
export function submitReport(store, service, { ip, isp, component, salt, now = Date.now() }) {
  const ipHash = hashIp(ip, salt);
  const recent = store.reportsFor(service.slug, now - DEDUPE_MS);
  if (recent.some((r) => r.ipHash === ipHash)) {
    return { accepted: false, reason: 'Bu servis için kısa süre önce bildirim yaptın; teşekkürler!' };
  }
  const report = { slug: service.slug, t: now, ipHash };
  if (isp && ISPS[isp]) report.isp = isp;
  const allowed = service.game?.components || [];
  if (component && allowed.includes(component) && COMPONENT_LABELS[component]) report.component = component;
  store.addReport(report);
  return { accepted: true };
}
