import { createPublicKey, verify } from 'node:crypto';
import { discordEmbed } from './notify.js';
import { STATE_LABELS } from './scoring.js';
import { COMPONENT_LABELS } from './catalog.js';

// Discord botu, gateway bağlantısı gerektirmeyen "HTTP interactions" modeliyle çalışır:
// slash komutları /discord/interactions adresine gelir, bildirimler REST API ile kanala yazılır.

const API = 'https://discord.com/api/v10';
const MANAGE_GUILD = 1n << 5n;
const MANAGE_CHANNELS = 1n << 4n;
const ADMINISTRATOR = 1n << 3n;
// Mesaj Gönder + Bağlantı Yerleştir
export const INSTALL_PERMISSIONS = String((1n << 11n) | (1n << 14n));

export function publicKeyFromHex(hex) {
  const x = Buffer.from(hex, 'hex').toString('base64url');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

export function verifyDiscordRequest(publicKey, signatureHex, timestamp, rawBody) {
  if (!publicKey || !signatureHex || !timestamp) return false;
  try {
    return verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), publicKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

export function commandDefinitions(games) {
  const choices = games.slice(0, 25).map((g) => ({ name: g.name, value: g.slug }));
  const gameOption = { type: 3, name: 'oyun', description: 'Oyun veya platform', required: true, choices };
  return [
    { name: 'takip', description: 'Bu kanalda bir oyunun kesintilerini bildir', type: 1, options: [gameOption] },
    { name: 'birak', description: 'Bu kanaldaki oyun takibini bırak', type: 1, options: [gameOption] },
    { name: 'liste', description: 'Bu kanalda takip edilen oyunlar', type: 1 },
    { name: 'durum', description: 'Bir oyunun şu anki durumu', type: 1, options: [gameOption] },
  ];
}

export class DiscordBot {
  constructor({ store, catalog, engine, appId, publicKeyHex, botToken, publicUrl }) {
    Object.assign(this, { store, catalog, engine, appId, botToken, publicUrl });
    this.publicKey = publicKeyHex ? publicKeyFromHex(publicKeyHex) : null;
    this.games = catalog.services.filter((s) => s.category === 'oyun');
  }

  get enabled() {
    return Boolean(this.publicKey && this.botToken);
  }

  installUrl() {
    if (!this.appId) return null;
    return `https://discord.com/oauth2/authorize?client_id=${this.appId}&scope=bot%20applications.commands&permissions=${INSTALL_PERMISSIONS}`;
  }

  get follows() {
    return this.store.data.discord;
  }

  handle(interaction) {
    if (interaction.type === 1) return { type: 1 }; // PING
    if (interaction.type !== 2) return reply('Desteklenmeyen etkileşim.');
    const { name, options = [] } = interaction.data;
    const slug = options.find((o) => o.name === 'oyun')?.value;
    const channelId = interaction.channel_id || interaction.channel?.id;
    const guildId = interaction.guild_id;

    if (name === 'durum') {
      const service = this.catalog.bySlug.get(slug);
      if (!service) return reply('Bu oyunu tanımıyorum.');
      const v = this.engine.view(slug);
      const lines = [`**${service.name}: ${v.label}** (güven %${Math.round(v.confidence * 100)})`, ...v.reasons.slice(0, 3).map((r) => `• ${r}`)];
      for (const c of v.components || []) lines.push(`${COMPONENT_LABELS[c.key] || c.key}: ${STATE_LABELS[c.state]}`);
      lines.push(`${this.publicUrl}/s/${slug}`);
      return reply(lines.join('\n'));
    }

    if (!guildId) return reply('Takip komutları yalnızca sunucu kanallarında kullanılabilir.');
    const perms = BigInt(interaction.member?.permissions || '0');
    const canManage = (perms & (MANAGE_GUILD | MANAGE_CHANNELS | ADMINISTRATOR)) !== 0n;

    if (name === 'liste') {
      const mine = this.follows.filter((f) => f.channelId === channelId).map((f) => this.catalog.bySlug.get(f.slug)?.name || f.slug);
      return reply(mine.length ? `Bu kanalda takip edilenler: ${mine.join(', ')}` : 'Bu kanalda takip edilen oyun yok. `/takip` ile ekleyebilirsin.');
    }

    if (!canManage) return reply('Bu komut için "Sunucuyu Yönet" veya "Kanalları Yönet" yetkisi gerekiyor.');
    const service = this.catalog.bySlug.get(slug);
    if (!service) return reply('Bu oyunu tanımıyorum.');

    if (name === 'takip') {
      if (this.follows.some((f) => f.channelId === channelId && f.slug === slug)) return reply(`${service.name} zaten bu kanalda takip ediliyor.`);
      if (this.follows.filter((f) => f.guildId === guildId).length >= 50) return reply('Bir sunucu en fazla 50 takip ekleyebilir.');
      this.follows.push({ guildId, channelId, slug, createdAt: Date.now() });
      this.store.touch();
      return reply(`✅ ${service.name} artık bu kanalda takip ediliyor. Çöktüğünde ya da düzeldiğinde buraya yazacağım.`, false);
    }
    if (name === 'birak') {
      const before = this.follows.length;
      this.store.data.discord = this.follows.filter((f) => !(f.channelId === channelId && f.slug === slug));
      this.store.touch();
      return reply(before === this.follows.length ? `${service.name} bu kanalda takip edilmiyordu.` : `${service.name} takibi bırakıldı.`);
    }
    return reply('Bilinmeyen komut.');
  }

  // Notifier tarafından durum değişikliğinde çağrılır.
  async notify(service, payload) {
    if (!this.botToken) return;
    const channels = [...new Set(this.follows.filter((f) => f.slug === service.slug).map((f) => f.channelId))];
    const body = JSON.stringify({ embeds: [discordEmbed(payload)] });
    await Promise.allSettled(
      channels.map(async (channelId) => {
        const res = await fetch(`${API}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { authorization: `Bot ${this.botToken}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        // Kanal silinmiş ya da bot atılmışsa takibi temizle.
        if (res.status === 404 || res.status === 403) {
          this.store.data.discord = this.follows.filter((f) => f.channelId !== channelId);
          this.store.touch();
        }
      }),
    );
  }
}

function reply(content, ephemeral = true) {
  return { type: 4, data: { content, flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } };
}
