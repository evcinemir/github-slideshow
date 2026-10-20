import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { regionLabel } from './config.js';
import { COMPONENT_LABELS, ISPS } from './catalog.js';
import { histogram, ispBreakdown, STATE_LABELS } from './scoring.js';
import { submitReport } from './reports.js';
import { RateLimiter } from './ratelimit.js';
import { verifyDiscordRequest } from './discord.js';
import { DEPENDENCY_REGIONS, officialByRegion } from './dependencies.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  // "Sadece ben miyim?" testi tarayıcıdan rastgele servis adreslerine bağlandığı için connect-src geniş tutulur.
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src *; frame-ancestors 'none'; base-uri 'none'",
};

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    Object.assign(this, { status, headers });
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', ...headers });
  res.end(payload);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'İstek gövdesi çok büyük');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return raw.length ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'Geçersiz JSON');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function simplePage(title, message) {
  return `<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"><body><main class="container narrow"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">Ana sayfaya dön</a></p></main></body></html>`;
}

export function createApp({ config, catalog, store, engine, notifier, discord }) {
  const publicDir = path.join(config.root, 'public');
  const apiLimiter = new RateLimiter({ limit: config.api.freePerHour, windowMs: 3600_000 });
  const uiLimiter = new RateLimiter({ limit: 600, windowMs: 10 * 60_000 });
  const reportLimiter = new RateLimiter({ limit: 30, windowMs: 3600_000 });
  const subscribeLimiter = new RateLimiter({ limit: 10, windowMs: 3600_000 });

  const clientIp = (req) => {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  };

  const limit = (limiter, req, res) => {
    const r = limiter.take(clientIp(req));
    res.setHeader('x-ratelimit-limit', r.limit);
    res.setHeader('x-ratelimit-remaining', r.remaining);
    res.setHeader('x-ratelimit-reset', r.resetSec);
    if (!r.allowed) throw new HttpError(429, 'İstek sınırı aşıldı, biraz sonra tekrar dene', { 'retry-after': String(r.resetSec) });
  };

  const serviceOr404 = (slug) => {
    const s = catalog.bySlug.get(slug);
    if (!s) throw new HttpError(404, 'Servis bulunamadı');
    return s;
  };

  const brief = (s) => {
    const v = engine.view(s.slug);
    return { slug: s.slug, name: s.name, category: s.category, state: v.state, label: v.label, confidence: v.confidence, reportsLast15m: v.reports.recent };
  };

  const regionDetails = (slug, states) =>
    config.regions.map((region) => {
      const last = store.probes(slug)[region]?.at(-1);
      return {
        region,
        label: regionLabel(region),
        state: states[region] || null,
        checkedAt: last ? new Date(last.t).toISOString() : null,
        latencyMs: last?.http?.ms ?? null,
        http: last ? { ok: last.http.ok, status: last.http.status ?? null, error: last.http.error ?? null } : null,
        dns: last ? { ok: last.dns.ok, ms: last.dns.ms, error: last.dns.error ?? null } : null,
        ssl: last?.tls ? { ok: last.tls.ok, daysLeft: last.tls.daysLeft ?? null, issuer: last.tls.issuer ?? null, error: last.tls.error ?? null } : null,
      };
    });

  const officialView = (slug) => {
    const o = store.official(slug);
    if (!o) return null;
    return {
      ok: o.ok,
      indicator: o.indicator ?? null,
      description: o.description ?? '',
      pageUrl: o.pageUrl ?? null,
      fetchedAt: o.fetchedAt ? new Date(o.fetchedAt).toISOString() : null,
      incidents: (o.incidents || []).slice(0, 5),
    };
  };

  // Herkese açık API'nin servis durumu cevabı.
  const statusPayload = (s) => {
    const v = engine.view(s.slug);
    return {
      service: { slug: s.slug, name: s.name, category: s.category, url: s.url },
      status: {
        state: v.state,
        label: v.label,
        confidence: v.confidence,
        reasons: v.reasons,
        since: v.since ? new Date(v.since).toISOString() : null,
        updatedAt: new Date(v.updatedAt).toISOString(),
      },
      regions: regionDetails(s.slug, v.regions),
      reports: { last15m: v.reports.recent, last24h: v.reports.last24h, baselinePer15m: v.reports.baseline },
      components: v.components?.map((c) => ({ ...c, label: COMPONENT_LABELS[c.key] || c.key, stateLabel: STATE_LABELS[c.state] })) ?? null,
      official: officialView(s.slug),
    };
  };

  const problems = () =>
    catalog.services
      .map(brief)
      .filter((b) => b.state === 'down' || b.state === 'degraded')
      .sort((a, b) => (a.state === b.state ? b.reportsLast15m - a.reportsLast15m : a.state === 'down' ? -1 : 1));

  const dependencies = () => ({
    regions: Object.entries(DEPENDENCY_REGIONS).map(([key, r]) => ({ key, label: r.label })),
    probeRegions: config.regions.map((r) => ({ key: r, label: regionLabel(r) })),
    services: catalog.services
      .filter((s) => s.infra)
      .map((s) => {
        const v = engine.view(s.slug);
        return { ...brief(s), measured: v.regions, official: officialByRegion(s, store.official(s.slug)), officialUrl: s.official?.url ?? null };
      }),
  });

  // --- Rotalar -------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/healthz', () => ({ ok: true, region: config.region }));

  // Herkese açık API (ücretsiz katman: IP başına saatlik sınır)
  route('GET', '/api/v1/services', (req, res) => {
    limit(apiLimiter, req, res);
    return { categories: catalog.categories, services: catalog.services.map(brief) };
  });
  route('GET', '/api/v1/status/:slug', (req, res, { slug }) => {
    limit(apiLimiter, req, res);
    return statusPayload(serviceOr404(slug));
  });
  route('GET', '/api/v1/problems', (req, res) => {
    limit(apiLimiter, req, res);
    return { services: problems() };
  });
  route('GET', '/api/v1/dependencies', (req, res) => {
    limit(apiLimiter, req, res);
    return dependencies();
  });

  route('POST', '/api/v1/subscriptions', async (req, res) => {
    limit(subscribeLimiter, req, res);
    const body = await readJson(req);
    try {
      if (body.webhook) {
        const sub = await notifier.createWebhook({ url: body.webhook, services: body.services });
        return [201, { id: sub.id, kind: 'webhook', services: sub.services, secret: sub.secret, unsubscribeUrl: `${config.publicUrl}/api/v1/subscriptions/unsubscribe?token=${sub.token}`, note: 'secret yalnızca bir kez gösterilir; X-CoktuMu-Signature başlığını doğrulamak için sakla.' }];
      }
      if (body.email) {
        const sub = await notifier.createEmail({ email: body.email, services: body.services });
        return [202, { id: sub.id, kind: 'email', services: sub.services, message: 'Onay e-postası gönderildi. Linke tıklayınca bildirimler başlar.' }];
      }
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    throw new HttpError(400, '"webhook" veya "email" alanı gerekli');
  });
  route('GET', '/api/v1/subscriptions/confirm', (req, res, params, url) => {
    const sub = notifier.confirm(url.searchParams.get('token'));
    return [sub ? 200 : 404, sub ? simplePage('Abonelik onaylandı', 'Takip ettiğin servislerin durumu değiştiğinde e-posta alacaksın.') : simplePage('Bağlantı geçersiz', 'Bu onay bağlantısı geçersiz ya da süresi dolmuş.')];
  });
  route('GET', '/api/v1/subscriptions/unsubscribe', (req, res, params, url) => {
    const sub = notifier.unsubscribe(url.searchParams.get('token'));
    return [sub ? 200 : 404, sub ? simplePage('Abonelik bitirildi', 'Artık bu abonelik için bildirim almayacaksın.') : simplePage('Bağlantı geçersiz', 'Bu abonelik zaten silinmiş olabilir.')];
  });

  // Web arayüzünün kullandığı uç noktalar (daha cömert sınır)
  route('GET', '/ui/home', (req, res) => {
    limit(uiLimiter, req, res);
    return {
      categories: catalog.categories,
      problems: problems(),
      services: catalog.services.map((s) => ({ ...brief(s), popular: Boolean(s.popular), search: s.search, game: Boolean(s.game) })),
    };
  });
  route('GET', '/ui/service/:slug', (req, res, { slug }) => {
    limit(uiLimiter, req, res);
    const s = serviceOr404(slug);
    const reports = store.reportsFor(s.slug, Date.now() - 24 * 3600_000);
    return {
      ...statusPayload(s),
      host: s.host,
      histogram: histogram(reports).map((b) => b.count),
      isps: ispBreakdown(reports, { labels: ISPS }),
      ispOptions: ISPS,
      componentOptions: (s.game?.components || []).map((k) => ({ key: k, label: COMPONENT_LABELS[k] })),
    };
  });
  route('GET', '/ui/games', (req, res) => {
    limit(uiLimiter, req, res);
    return {
      discordInstallUrl: discord?.installUrl() ?? null,
      games: catalog.services.filter((s) => s.game).map((s) => {
        const v = engine.view(s.slug);
        return { ...brief(s), components: v.components.map((c) => ({ ...c, label: COMPONENT_LABELS[c.key] })) };
      }),
    };
  });
  route('GET', '/ui/dependencies', (req, res) => {
    limit(uiLimiter, req, res);
    return dependencies();
  });
  route('POST', '/ui/report', async (req, res) => {
    limit(reportLimiter, req, res);
    const body = await readJson(req);
    const s = serviceOr404(String(body.slug || ''));
    const result = submitReport(store, s, { ip: clientIp(req), isp: body.isp, component: body.component, salt: config.ipSalt });
    if (result.accepted) engine.recompute(s.slug);
    return [result.accepted ? 201 : 200, result];
  });
  route('GET', '/ui/ping', () => [204, '']);

  // Diğer bölgelerdeki ölçüm ajanlarından gelen sonuçlar
  route('POST', '/internal/probes', async (req) => {
    const auth = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${config.agentToken}`);
    if (!config.agentToken || auth.length !== expected.length || !timingSafeEqual(auth, expected)) throw new HttpError(401, 'Yetkisiz');
    const body = JSON.parse(await readBody(req, 2 * 1024 * 1024));
    const region = String(body.region || '');
    if (!config.regions.includes(region)) throw new HttpError(400, `Bilinmeyen bölge: ${region}`);
    let accepted = 0;
    for (const r of body.results || []) {
      if (!catalog.bySlug.has(r.slug) || typeof r.result?.t !== 'number') continue;
      // Ajan saatine körü körüne güvenme: gelecekten gelen zaman damgalarını kırp.
      store.addProbe(r.slug, region, { ...r.result, region, t: Math.min(r.result.t, Date.now()) });
      engine.recompute(r.slug);
      accepted++;
    }
    return { accepted };
  });

  route('POST', '/discord/interactions', async (req) => {
    if (!discord?.publicKey) throw new HttpError(404, 'Discord botu yapılandırılmamış');
    const raw = await readBody(req);
    const ok = verifyDiscordRequest(discord.publicKey, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'], raw);
    if (!ok) throw new HttpError(401, 'invalid request signature');
    return discord.handle(JSON.parse(raw));
  });

  // --- Statik dosyalar ve SPA ----------------------------------------------
  const SPA_ROUTES = /^\/(?:$|s\/[\w-]+$|oyunlar$|altyapi$|gelistiriciler$)/;
  async function serveStatic(req, res, pathname) {
    let file = SPA_ROUTES.test(pathname) ? 'index.html' : pathname.slice(1);
    file = path.normalize(file);
    if (file.startsWith('..') || path.isAbsolute(file)) throw new HttpError(404, 'Bulunamadı');
    try {
      const data = await readFile(path.join(publicDir, file));
      const ext = path.extname(file);
      const cache = file === 'index.html' || file === 'sw.js' ? 'no-cache' : 'public, max-age=300';
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cache });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      throw new HttpError(404, 'Bulunamadı');
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    const isApi = /^\/(api|ui|internal|discord|healthz)/.test(url.pathname);
    try {
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('access-control-allow-origin', '*');
        if (req.method === 'OPTIONS') {
          return send(res, 204, '', { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
        }
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        let out = await r.handler(req, res, params, url);
        let status = 200;
        if (Array.isArray(out)) [status, out] = out;
        if (status === 204) return send(res, 204, '');
        return send(res, status, out, url.pathname.startsWith('/api/') || url.pathname.startsWith('/ui/') ? { 'cache-control': 'no-store' } : {});
      }
      if (isApi) throw new HttpError(404, 'Bulunamadı');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'İzin verilmeyen metot');
      await serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.end();
      const message = status === 500 ? 'Sunucu hatası' : err.message;
      if (isApi) send(res, status, { error: message }, err.headers);
      else send(res, status, simplePage(status === 404 ? 'Sayfa bulunamadı' : 'Hata', message), err.headers);
    }
  }

  return { server: http.createServer(handler), handler };
}
