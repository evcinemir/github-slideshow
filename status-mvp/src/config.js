import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const env = process.env;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(env.PORT || 8080);

export const REGION_LABELS = {
  istanbul: 'İstanbul',
  frankfurt: 'Frankfurt',
  'us-east': 'ABD (Doğu)',
};

export const config = {
  root,
  port,
  publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir: env.DATA_DIR || path.join(root, 'data'),

  // Bu sunucunun kendi ölçüm bölgesi; diğer bölgeler src/agent.js ile sonuç gönderir.
  region: env.REGION || 'istanbul',
  regions: (env.REGIONS || 'istanbul,frankfurt,us-east').split(',').map((r) => r.trim()).filter(Boolean),
  agentToken: env.AGENT_TOKEN || '',

  probeIntervalMs: Number(env.PROBE_INTERVAL_MS || 90_000),
  probeTimeoutMs: Number(env.PROBE_TIMEOUT_MS || 10_000),
  probeConcurrency: Number(env.PROBE_CONCURRENCY || 8),
  slowMs: Number(env.SLOW_MS || 3_000),
  officialIntervalMs: Number(env.OFFICIAL_INTERVAL_MS || 120_000),
  disableProbes: env.DISABLE_PROBES === '1',
  disableOfficial: env.DISABLE_OFFICIAL === '1',
  demo: env.DEMO === '1',

  // Durum değişikliği bu süre boyunca sabit kalmadan bildirim gönderilmez (titreşimi önler).
  notifyDebounceMs: Number(env.NOTIFY_DEBOUNCE_MS || 120_000),

  // IP adresleri saklanmaz; yalnızca tuzlanmış özetleri tutulur.
  ipSalt: env.IP_SALT || randomBytes(16).toString('hex'),
  trustProxy: env.TRUST_PROXY === '1',

  api: {
    freePerHour: Number(env.API_FREE_PER_HOUR || 60),
  },

  allowPrivateWebhooks: env.ALLOW_PRIVATE_WEBHOOKS === '1',

  mail: {
    resendApiKey: env.RESEND_API_KEY || '',
    from: env.MAIL_FROM || 'ÇöktüMü <bildirim@example.com>',
  },

  discord: {
    appId: env.DISCORD_APP_ID || '',
    publicKey: env.DISCORD_PUBLIC_KEY || '',
    botToken: env.DISCORD_BOT_TOKEN || '',
  },
};

export function regionLabel(region) {
  return REGION_LABELS[region] || region;
}
