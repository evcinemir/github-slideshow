# ÇöktüMü? — servis durum izleme MVP

"Servis çöktü mü, yoksa sadece ben mi?" sorusunu genel kullanıcı, oyuncu ve geliştirici için cevaplayan en küçük sürüm.
**Sıfır bağımlılık**: yalnızca Node.js 22+ gerekir (`npm install` yok).

```bash
npm run demo     # internet olmadan sentetik verilerle arayüzü dene → http://localhost:8080
npm start        # gerçek izleme (bu sunucu İstanbul bölgesi olarak ölçer)
npm test         # 32 test: skorlama, ayrıştırıcılar, API, webhook, Discord imzası...
```

## Ne var?

### Ortak çekirdek
| Özellik | Nerede |
|---|---|
| 68 servislik katalog (sosyal, banka, e-Devlet, alışveriş, operatör, 13 oyun, 12 altyapı) | `data/services.json` |
| HTTP + DNS + SSL ölçümü, servis başına 90 sn'de bir (ayarlanabilir), rastgele kaydırmalı ve sınırlı eşzamanlı | `src/probes.js`, `src/monitor.js` |
| 3 bölge: merkez sunucu kendi bölgesini ölçer, diğer bölgelerde `src/agent.js` çalışır ve sonuçları `/internal/probes`'a yollar | `src/agent.js` |
| Durum skoru: Çalışıyor / Sorunlu / Çökmüş + güven yüzdesi + "Neden bu sonuç?" açıklamaları | `src/scoring.js` |
| "Bende de çalışmıyor" butonu, 24 saatlik (15 dk'lık) grafik; IP saklanmaz, tuzlu özet ile 30 dk tekrar engeli | `src/reports.js` |
| Resmi durum sayfaları: Atlassian Statuspage (Discord, Cloudflare, GitHub, Vercel, Epic, Reddit…), Riot (Valorant, LoL), AWS Health | `src/official.js` |

**Skor nasıl hesaplanır?** Üç sinyal ağırlıklı oylanır: bölge ölçümleri (0.55 × kapsama), kullanıcı bildirimleri
(son 15 dk, son 1 saat hariç 24 saatlik ortalamaya göre artış) ve resmi gösterge. Tek bir başarısız ölçüm "doğrulanmamış"
sayılır (sorunlu), arka arkaya iki başarısızlık "çökmüş". Resmi `critical` her zaman çökmüş sayılır. Güven yüzdesi
sinyallerin kararla uyumuna ve veri kapsamına bağlıdır. Durum değişiklikleri 2 dk sabit kalmadan (ya da güven ≥ %90 olmadan)
bildirim tetiklemez.

### Genel kullanıcı
- **Sadece ben miyim?** testi tarayıcıda: sitemize erişim, genel DNS (DNS-over-HTTPS: Cloudflare + Google), cihazdan servise
  doğrudan bağlantı ve bizim ölçümlerimiz karşılaştırılıp sonuç sade Türkçe ile açıklanır.
- **Sağlayıcı kırılımı**: bildirimde Türk Telekom, Superonline, Turkcell, Vodafone, TurkNet… seçilir (tarayıcıda hatırlanır);
  son 1 saatin dağılımı gösterilir, tek sağlayıcıda yoğunlaşma varsa uyarılır.
- Mobil uyumlu ana sayfa: arama (Türkçe karakter duyarsız), "şu an sorun yaşayan servisler", kategoriler. PWA (manifest + service worker).

### Oyuncu
- 13 oyun/platform: Valorant, LoL, CS2, Fortnite, PUBG, Steam, Epic, PSN, Xbox, Roblox, Minecraft, Battle.net, EA.
- Oyun içi kırılım (giriş / eşleştirme / mağaza…): resmi bileşenler + bileşen seçilerek yapılan bildirimlerden (`computeComponents`).
- **Discord botu** (HTTP interactions; gateway gerekmez): `/takip oyun:`, `/birak oyun:`, `/liste`, `/durum oyun:`.
  Takip edilen oyunun durumu değişince kanala embed mesaj atar. Kurulum aşağıda.

### Geliştirici
- `GET /api/v1/status/{servis}`, `/api/v1/services`, `/api/v1/problems`, `/api/v1/dependencies` — CORS açık,
  ücretsiz katman IP başına saatte 60 istek (`X-RateLimit-*` başlıkları).
- **Altyapı görünümü** (`/altyapi`): AWS, Cloudflare, GitHub, Vercel, DigitalOcean… için bizim 3 ölçüm noktamız +
  resmi bileşenlerin Avrupa / Kuzey Amerika / Asya-Pasifik eşleşmesi.
- **Webhook ve e-posta**: `POST /api/v1/subscriptions` `{ "services": ["github"], "webhook": "https://..." }` veya `"email"`.
  Webhook'lar `X-CoktuMu-Signature: sha256=HMAC(secret, gövde)` ile imzalanır, 3 kez yeniden denenir, iç ağ adresleri (SSRF)
  reddedilir. Discord webhook URL'leri otomatik Discord biçiminde gönderilir. E-posta çift onaylıdır (Resend API; anahtar
  yoksa e-postalar konsola yazılır).

## Yapılandırma (ortam değişkenleri)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT`, `PUBLIC_URL` | `8080`, `http://localhost:8080` | |
| `REGION`, `REGIONS` | `istanbul`, `istanbul,frankfurt,us-east` | Bu sunucunun bölgesi ve beklenen tüm bölgeler |
| `AGENT_TOKEN` | — | Bölge ajanlarının paylaşılan gizli anahtarı |
| `PROBE_INTERVAL_MS`, `PROBE_TIMEOUT_MS`, `SLOW_MS` | `90000`, `10000`, `3000` | |
| `OFFICIAL_INTERVAL_MS` | `120000` | Resmi sayfaları çekme aralığı |
| `NOTIFY_DEBOUNCE_MS` | `120000` | |
| `IP_SALT` | rastgele | Bildirim tekrar engeli için IP özetinde kullanılan tuz (kalıcı olsun istiyorsan ayarla) |
| `TRUST_PROXY=1` | kapalı | Ters vekil arkasındaysan `X-Forwarded-For` kullan |
| `API_FREE_PER_HOUR` | `60` | |
| `RESEND_API_KEY`, `MAIL_FROM` | — | E-posta gönderimi |
| `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` | — | Discord botu |
| `DEMO=1`, `DISABLE_PROBES=1`, `DISABLE_OFFICIAL=1` | | |

Veri `data/state.json` dosyasında tutulur (30 sn'de bir ve kapanışta yazılır).

### Bölge ajanı (Frankfurt, ABD)
Her bölgede küçük bir VM'de:
```bash
REGION=frankfurt SERVER_URL=https://coktumu.example AGENT_TOKEN=... node src/agent.js
```
Merkez sunucuda aynı `AGENT_TOKEN` ayarlı olmalı.

### Discord botu kurulumu
1. discord.com/developers'ta uygulama + bot oluştur; `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` ayarla.
2. *Interactions Endpoint URL* → `https://<alan-adın>/discord/interactions`
3. `npm run discord:register` — komutları kaydeder ve sunucuya ekleme linkini yazar (link `/oyunlar` sayfasında da görünür).

## Bilinen sınırlar / sonraki adımlar
- Riot ve AWS uç noktaları herkese açık ama resmi olarak belgelenmemiş; biçim değişirse ayrıştırıcılar `ok:false` döner ve skor
  yalnızca ölçüm + bildirimlerle devam eder. Steam, PSN, Xbox için resmi API yok: yalnızca ölçüm + bildirim.
- Depolama tek süreçli JSON; trafik artınca Postgres/Redis'e taşınmalı. Hız sınırlayıcı da bellek içi.
- Webhook SSRF kontrolü DNS'i gönderimden önce çözer (DNS rebinding'e karşı tam koruma için sabit IP'ye bağlanılmalı).
- Bildirim spam'ine karşı şimdilik IP özeti + hız sınırı var; büyüyünce Turnstile/captcha eklenmeli.
- MVP dışı (bilerek): erişim engeli tespiti, mobil uygulama, geçmiş güvenilirlik karnesi, kısmi akış testleri, hesaplar/ücretli plan.
