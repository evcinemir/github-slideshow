import path from 'node:path';
import { config } from './config.js';
import { loadCatalog } from './catalog.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { Mailer, Notifier } from './notify.js';
import { DiscordBot } from './discord.js';
import { startMonitor } from './monitor.js';
import { startOfficialPoller } from './official.js';
import { seedDemo, startDemoProbes } from './demo.js';
import { createApp } from './app.js';

export function build(cfg = config, { storeFile } = {}) {
  const catalog = loadCatalog();
  const store = new Store(cfg.demo ? null : storeFile ?? path.join(cfg.dataDir, 'state.json')).load();
  const engine = new Engine({
    catalog,
    store,
    regions: cfg.regions,
    staleMs: Math.max(5 * 60_000, cfg.probeIntervalMs * 3),
    debounceMs: cfg.notifyDebounceMs,
  });
  const discord = new DiscordBot({
    store,
    catalog,
    engine,
    appId: cfg.discord.appId,
    publicKeyHex: cfg.discord.publicKey,
    botToken: cfg.discord.botToken,
    publicUrl: cfg.publicUrl,
  });
  const notifier = new Notifier({
    store,
    catalog,
    mailer: new Mailer(cfg.mail),
    discord,
    publicUrl: cfg.publicUrl,
    allowPrivateWebhooks: cfg.allowPrivateWebhooks,
  });
  engine.onChange = (service, change) => {
    console.log(`[durum] ${service.slug}: ${change.from} → ${change.to} (%${Math.round(change.result.confidence * 100)})`);
    notifier.onChange(service, change);
  };
  const app = createApp({ config: cfg, catalog, store, engine, notifier, discord });
  return { catalog, store, engine, notifier, discord, app };
}

export function start(cfg = config) {
  const ctx = build(cfg);
  const { catalog, store, engine } = ctx;

  if (cfg.demo) {
    seedDemo({ catalog, store, regions: cfg.regions });
    engine.recomputeAll();
    startDemoProbes({ catalog, store, engine, regions: cfg.regions });
  } else {
    if (!cfg.disableProbes) {
      startMonitor({
        services: catalog.services,
        region: cfg.region,
        intervalMs: cfg.probeIntervalMs,
        timeoutMs: cfg.probeTimeoutMs,
        slowMs: cfg.slowMs,
        concurrency: cfg.probeConcurrency,
        sink: (s, result) => {
          store.addProbe(s.slug, cfg.region, result);
          engine.recompute(s.slug);
        },
      });
    }
    if (!cfg.disableOfficial) startOfficialPoller({ catalog, store, engine, intervalMs: cfg.officialIntervalMs });
    store.autosave();
  }

  // Bayatlayan ölçümler ve bildirim pencereleri için periyodik yeniden hesaplama.
  setInterval(() => {
    store.pruneReports();
    engine.recomputeAll();
  }, 60_000).unref();

  const shutdown = () => {
    store.save();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  ctx.app.server.listen(cfg.port, () => {
    console.log(`ÇöktüMü? ${cfg.publicUrl} adresinde (bölge: ${cfg.region}${cfg.demo ? ', DEMO modu' : ''})`);
  });
  return ctx;
}

if (import.meta.url === `file://${process.argv[1]}`) start();
