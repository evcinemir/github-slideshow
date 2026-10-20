import { createHmac, randomBytes } from 'node:crypto';
import { assertPublicUrl } from './netsafe.js';
import { STATE_LABELS } from './scoring.js';

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_SUBSCRIPTIONS_PER_TARGET = 50;

export function sign(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

const token = () => randomBytes(18).toString('base64url');

export class Mailer {
  constructor({ resendApiKey, from }) {
    this.resendApiKey = resendApiKey;
    this.from = from;
    this.outbox = []; // geliştirme ve testler için
  }

  async send({ to, subject, text }) {
    if (!this.resendApiKey) {
      this.outbox.push({ to, subject, text });
      console.log(`[mail] (gönderilmedi, RESEND_API_KEY yok) ${to}: ${subject}\n${text}`);
      return;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.resendApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to, subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend HTTP ${res.status}`);
  }
}

export function eventPayload(service, { from, to, result, at }, publicUrl) {
  return {
    event: 'status.changed',
    service: { slug: service.slug, name: service.name, category: service.category },
    previous: { state: from, label: STATE_LABELS[from] },
    current: { state: to, label: STATE_LABELS[to], confidence: result.confidence, reasons: result.reasons },
    at: new Date(at).toISOString(),
    url: `${publicUrl}/s/${service.slug}`,
  };
}

const COLORS = { up: 0x22a06b, degraded: 0xe2a300, down: 0xd93a3a, unknown: 0x8a8f98 };
const EMOJI = { up: '🟢', degraded: '🟠', down: '🔴', unknown: '⚪' };

export function discordEmbed(payload) {
  const { service, current, previous, url } = payload;
  return {
    title: `${EMOJI[current.state]} ${service.name}: ${current.label}`,
    url,
    description: [
      `Önceki durum: ${previous.label}`,
      `Güven: %${Math.round(current.confidence * 100)}`,
      ...current.reasons.slice(0, 3).map((r) => `• ${r}`),
    ].join('\n'),
    color: COLORS[current.state],
    timestamp: payload.at,
    footer: { text: 'ÇöktüMü?' },
  };
}

export class Notifier {
  constructor({ store, catalog, mailer, discord, publicUrl, allowPrivateWebhooks = false, retryDelaysMs = [1_000, 5_000, 25_000] }) {
    Object.assign(this, { store, catalog, mailer, discord, publicUrl, allowPrivateWebhooks, retryDelaysMs });
  }

  get subscriptions() {
    return this.store.data.subscriptions;
  }

  validateServices(services) {
    const list = [...new Set(Array.isArray(services) ? services : [services])].filter(Boolean);
    if (!list.length) throw new Error('En az bir servis seçmelisin');
    for (const s of list) if (s !== '*' && !this.catalog.bySlug.has(s)) throw new Error(`Bilinmeyen servis: ${s}`);
    return list;
  }

  async createWebhook({ url, services }) {
    const parsed = await assertPublicUrl(url, { allowPrivate: this.allowPrivateWebhooks });
    const list = this.validateServices(services);
    if (this.subscriptions.filter((s) => s.target === parsed.href).length >= MAX_SUBSCRIPTIONS_PER_TARGET) throw new Error('Bu adres için çok fazla abonelik var');
    const sub = { id: token(), kind: 'webhook', target: parsed.href, services: list, secret: token(), token: token(), confirmed: true, createdAt: Date.now() };
    this.subscriptions.push(sub);
    this.store.touch();
    return sub;
  }

  // Çift onaylı e-posta aboneliği: onay linkine tıklanana kadar e-posta gönderilmez.
  async createEmail({ email, services }) {
    const to = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(to) || to.length > 254) throw new Error('Geçerli bir e-posta adresi gir');
    const list = this.validateServices(services);
    if (this.subscriptions.filter((s) => s.target === to).length >= MAX_SUBSCRIPTIONS_PER_TARGET) throw new Error('Bu adres için çok fazla abonelik var');
    const sub = { id: token(), kind: 'email', target: to, services: list, token: token(), confirmed: false, createdAt: Date.now() };
    this.subscriptions.push(sub);
    this.store.touch();
    const names = list.map((s) => (s === '*' ? 'tüm servisler' : this.catalog.bySlug.get(s).name)).join(', ');
    await this.mailer.send({
      to,
      subject: 'ÇöktüMü? aboneliğini onayla',
      text: `${names} için durum değişikliği bildirimleri almak üzere aboneliğini onayla:\n${this.publicUrl}/api/v1/subscriptions/confirm?token=${sub.token}\n\nBu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.`,
    });
    return sub;
  }

  confirm(tok) {
    const sub = this.subscriptions.find((s) => s.token === tok);
    if (!sub) return null;
    sub.confirmed = true;
    this.store.touch();
    return sub;
  }

  unsubscribe(tok) {
    const i = this.subscriptions.findIndex((s) => s.token === tok);
    if (i === -1) return null;
    const [sub] = this.subscriptions.splice(i, 1);
    this.store.touch();
    return sub;
  }

  // Engine.onChange buraya bağlanır.
  async onChange(service, change) {
    const payload = eventPayload(service, change, this.publicUrl);
    const subs = this.subscriptions.filter((s) => s.confirmed && (s.services.includes(service.slug) || s.services.includes('*')));
    const jobs = subs.map((s) => (s.kind === 'webhook' ? this.deliverWebhook(s, payload) : this.deliverEmail(s, payload)));
    if (this.discord) jobs.push(this.discord.notify(service, payload));
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === 'rejected') console.warn(`[notify] ${service.slug}: ${r.reason?.message}`);
    return results;
  }

  async deliverWebhook(sub, payload) {
    const isDiscord = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(sub.target);
    const body = JSON.stringify(isDiscord ? { username: 'ÇöktüMü?', embeds: [discordEmbed(payload)] } : payload);
    const headers = { 'content-type': 'application/json', 'user-agent': 'CoktuMu-Webhook/0.1', 'x-coktumu-event': payload.event };
    if (!isDiscord) headers['x-coktumu-signature'] = sign(sub.secret, body);
    let lastErr;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        await assertPublicUrl(sub.target, { allowPrivate: this.allowPrivateWebhooks });
        const res = await fetch(sub.target, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        if (res.ok) return;
        lastErr = new Error(`HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (err) {
        lastErr = err;
      }
      if (attempt < this.retryDelaysMs.length) await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
    }
    sub.failures = (sub.failures || 0) + 1;
    this.store.touch();
    throw new Error(`webhook ${sub.id} teslim edilemedi: ${lastErr?.message}`);
  }

  async deliverEmail(sub, payload) {
    const { service, current, previous } = payload;
    await this.mailer.send({
      to: sub.target,
      subject: `${service.name}: ${current.label}`,
      text: [
        `${service.name} durumu "${previous.label}" → "${current.label}" olarak değişti (güven %${Math.round(current.confidence * 100)}).`,
        '',
        ...current.reasons.map((r) => `- ${r}`),
        '',
        `Ayrıntılar: ${payload.url}`,
        `Aboneliği bitir: ${this.publicUrl}/api/v1/subscriptions/unsubscribe?token=${sub.token}`,
      ].join('\n'),
    });
  }
}
