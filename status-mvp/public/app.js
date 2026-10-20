// ÇöktüMü? istemci uygulaması: bağımlılıksız, History API ile yönlendirilen küçük bir SPA.
const view = document.getElementById('view');
const STATE = { up: 'Çalışıyor', degraded: 'Sorunlu', down: 'Çökmüş', unknown: 'Bilinmiyor' };
let refreshTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (x) => `%${Math.round((x || 0) * 100)}`;
const normalize = (t) =>
  String(t).toLocaleLowerCase('tr').replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c]).replace(/[^a-z0-9]+/g, ' ').trim();
const badge = (state, text) => `<span class="badge ${esc(state)}"><span class="dot ${esc(state)}"></span>${esc(text || STATE[state])}</span>`;

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${Math.max(s, 0)} sn önce`;
  if (s < 3600) return `${Math.round(s / 60)} dk önce`;
  if (s < 86400) return `${Math.round(s / 3600)} sa önce`;
  return `${Math.round(s / 86400)} gün önce`;
}

// --- Yönlendirme -------------------------------------------------------------
const routes = [
  [/^\/$/, renderHome],
  [/^\/s\/([\w-]+)$/, renderService],
  [/^\/oyunlar$/, renderGames],
  [/^\/altyapi$/, renderDependencies],
  [/^\/gelistiriciler$/, renderDevelopers],
];

async function router() {
  clearInterval(refreshTimer);
  const path = location.pathname;
  for (const a of document.querySelectorAll('.nav a')) {
    const href = a.getAttribute('href');
    a.toggleAttribute('aria-current', href === '/' ? path === '/' || path.startsWith('/s/') : path.startsWith(href));
    if (a.hasAttribute('aria-current')) a.setAttribute('aria-current', 'page');
  }
  for (const [re, fn] of routes) {
    const m = re.exec(path);
    if (m) {
      try {
        await fn(...m.slice(1));
      } catch (err) {
        view.innerHTML = `<div class="card"><h1>Bir sorun oluştu</h1><p class="muted">${esc(err.message)}</p><a href="/" data-link>Ana sayfa</a></div>`;
      }
      return;
    }
  }
  view.innerHTML = '<h1>Sayfa bulunamadı</h1><a href="/" data-link>Ana sayfa</a>';
}

function go(href) {
  history.pushState(null, '', href);
  router().then(() => {
    window.scrollTo(0, 0);
    view.focus({ preventScroll: true });
  });
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
window.addEventListener('popstate', router);

// --- Ana sayfa ---------------------------------------------------------------
async function renderHome() {
  document.title = 'ÇöktüMü? — Servis çöktü mü, yoksa sadece sen mi?';
  const data = await api('/ui/home');
  const byCat = {};
  for (const s of data.services) (byCat[s.category] ||= []).push(s);

  view.innerHTML = `
    <section class="hero">
      <h1>Çöktü mü, yoksa sadece sen mi?</h1>
      <p class="muted">${data.services.length} servisi İstanbul, Frankfurt ve ABD'den sürekli ölçüyoruz.</p>
      <div class="search" role="search">
        <input id="q" type="search" placeholder="Servis ara: Instagram, e-Devlet, Valorant…" autocomplete="off" aria-label="Servis ara" aria-controls="results">
        <div id="results" class="search-results hidden" role="listbox"></div>
      </div>
    </section>

    <section>
      <h2>Şu an sorun yaşayan servisler</h2>
      ${
        data.problems.length
          ? `<ul class="list card">${data.problems
              .map(
                (p) => `<li><a class="row" href="/s/${esc(p.slug)}" data-link>
                  <span><span class="row-title">${esc(p.name)}</span><br><span class="muted small">${p.reportsLast15m} bildirim · son 15 dk</span></span>
                  ${badge(p.state)}</a></li>`,
              )
              .join('')}</ul>`
          : `<div class="notice up">Şu anda bilinen bir sorun yok. 🎉</div>`
      }
    </section>

    ${Object.entries(data.categories)
      .filter(([k]) => byCat[k])
      .map(
        ([k, label]) => `<section><h2>${esc(label)}</h2><div class="grid">${byCat[k]
          .map((s) => `<a class="chip" href="/s/${esc(s.slug)}" data-link title="${esc(STATE[s.state])}"><span class="dot ${esc(s.state)}"></span><span class="name">${esc(s.name)}</span></a>`)
          .join('')}</div></section>`,
      )
      .join('')}
  `;

  const input = view.querySelector('#q');
  const results = view.querySelector('#results');
  let matches = [];
  let active = 0;
  const draw = () => {
    results.classList.toggle('hidden', !matches.length);
    results.innerHTML = matches
      .map((s, i) => `<a href="/s/${esc(s.slug)}" data-link role="option" class="${i === active ? 'active' : ''}"><span>${esc(s.name)}</span>${badge(s.state)}</a>`)
      .join('');
  };
  input.addEventListener('input', () => {
    const q = normalize(input.value);
    active = 0;
    matches = q ? data.services.filter((s) => s.search.includes(q)).sort((a, b) => b.popular - a.popular).slice(0, 8) : [];
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (!matches.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(`/s/${matches[active].slug}`);
    } else if (e.key === 'Escape') {
      matches = [];
      draw();
    }
  });
  if (matchMedia('(min-width: 700px)').matches) input.focus();
  refreshTimer = setInterval(() => {
    if (!input.value && document.visibilityState === 'visible') renderHome().catch(() => {});
  }, 60_000);
}

// --- Servis sayfası ----------------------------------------------------------
function chartSvg(counts) {
  const w = 960;
  const h = 140;
  const pad = 18;
  const max = Math.max(4, ...counts);
  const bw = w / counts.length;
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  const bars = counts
    .map((c, i) => {
      const bh = Math.round((c / max) * (h - pad - 6));
      const cls = c >= Math.max(5, avg * 3) ? 'hot' : '';
      return `<rect class="${cls}" x="${(i * bw + 1).toFixed(1)}" y="${h - pad - bh}" width="${(bw - 2).toFixed(1)}" height="${bh}"><title>${c} bildirim</title></rect>`;
    })
    .join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Son 24 saatteki kullanıcı bildirimleri, en yüksek ${Math.max(...counts)}">
    <line x1="0" x2="${w}" y1="${h - pad}" y2="${h - pad}"/>${bars}
  </svg>
  <div class="muted small" style="display:flex;justify-content:space-between"><span>24 sa önce</span><span>12 sa önce</span><span>şimdi</span></div>`;
}

function regionRows(regions) {
  return regions
    .map((r) => {
      if (!r.checkedAt) return `<tr><td>${esc(r.label)}</td><td colspan="5" class="muted">Henüz ölçüm yok</td></tr>`;
      const httpTxt = r.http.ok ? `${r.http.status}` : esc(r.http.error || r.http.status);
      const sslTxt = !r.ssl ? '—' : r.ssl.ok ? `geçerli · ${r.ssl.daysLeft} gün` : esc(r.ssl.error || 'geçersiz');
      return `<tr>
        <td>${esc(r.label)}</td>
        <td>${badge(r.state || 'unknown')}</td>
        <td class="${r.dns.ok ? 'ok' : 'bad'}">${r.dns.ok ? `✓ ${r.dns.ms} ms` : `✗ ${esc(r.dns.error)}`}</td>
        <td class="${r.http.ok ? 'ok' : 'bad'}">${r.http.ok ? '✓' : '✗'} ${httpTxt}</td>
        <td class="${!r.ssl ? '' : r.ssl.ok ? (r.ssl.daysLeft < 14 ? 'warn' : 'ok') : 'bad'}">${sslTxt}</td>
        <td>${r.latencyMs != null ? `${r.latencyMs} ms` : '—'} <span class="muted small">· ${ago(r.checkedAt)}</span></td>
      </tr>`;
    })
    .join('');
}

async function renderService(slug) {
  const d = await api(`/ui/service/${encodeURIComponent(slug)}`);
  const s = d.status;
  document.title = `${d.service.name} çöktü mü? ${STATE[s.state]} — ÇöktüMü?`;
  const savedIsp = store('isp') || '';
  const official = d.official;

  view.innerHTML = `
    <p class="small"><a href="/" data-link>← Tüm servisler</a></p>
    <section class="card status-hero ${esc(s.state)}">
      <div>
        <h1>${esc(d.service.name)} çöktü mü?</h1>
        <div class="status-big ${esc(s.state)}">${esc(s.label)}</div>
        <div class="muted small">${s.state === 'unknown' ? 'Yeterli veri yok' : `${pct(s.confidence)} güven`} · ${s.since ? `${ago(s.since)} beri` : ''} · güncellendi ${ago(s.updatedAt)}</div>
      </div>
      <div class="actions">
        <button class="danger" id="report-open">Bende de çalışmıyor</button>
        <button id="check-open">Sadece ben miyim?</button>
      </div>
    </section>

    <section id="report-panel" class="card hidden" style="margin-top:12px">
      <h2 style="margin-top:0">Sorun bildir</h2>
      <form id="report-form" class="form-grid">
        <div>
          <label for="isp">İnternet sağlayıcın</label>
          <select id="isp" name="isp">
            <option value="">Belirtmek istemiyorum</option>
            ${Object.entries(d.ispOptions).map(([k, v]) => `<option value="${esc(k)}" ${k === savedIsp ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
        </div>
        ${
          d.componentOptions.length
            ? `<div><label for="component">Ne çalışmıyor?</label><select id="component" name="component"><option value="">Genel / emin değilim</option>${d.componentOptions
                .map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`)
                .join('')}</select></div>`
            : ''
        }
        <div><button class="primary" type="submit">Bildir</button></div>
      </form>
      <p id="report-msg" class="small muted" role="status"></p>
    </section>

    <section id="check-panel" class="card hidden" style="margin-top:12px" aria-live="polite"></section>

    ${s.reasons.length ? `<h2>Neden bu sonuç?</h2><ul>${s.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}

    ${
      d.components
        ? `<h2>Oyun içi servisler</h2><div class="grid-3">${d.components
            .map((c) => `<div class="card comp"><strong>${esc(c.label)}</strong>${badge(c.state)}<span class="muted small">Kaynak: ${esc(c.source)}${c.reports ? ` · ${c.reports} bildirim` : ''}</span></div>`)
            .join('')}</div>`
        : ''
    }

    <h2>Son 24 saatteki bildirimler</h2>
    <div class="card">
      ${chartSvg(d.histogram)}
      <p class="small muted" style="margin:.5rem 0 0">Son 15 dk: <strong>${d.reports.last15m}</strong> · 24 saat: <strong>${d.reports.last24h}</strong> · normal: ~${d.reports.baselinePer15m}/15 dk</p>
    </div>

    <h2>Sağlayıcıya göre (son 1 saat)</h2>
    <div class="card">
      ${
        d.isps.length
          ? d.isps.map((i) => `<div class="hbar"><span>${esc(i.label)}</span><span class="track"><span class="fill" style="width:${i.share}%"></span></span><span class="num">%${i.share}</span></div>`).join('') +
            (d.isps[0].share >= 60 && d.isps.length > 1 && d.isps[0].count >= 5
              ? `<p class="small" style="margin-top:.5rem">Bildirimlerin çoğu <strong>${esc(d.isps[0].label)}</strong> kullanıcılarından geliyor; sorun bu sağlayıcıya özel olabilir.</p>`
              : '')
          : '<p class="muted">Son bir saatte bildirim yok.</p>'
      }
    </div>

    <h2>Ölçüm noktaları</h2>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Bölge</th><th>Durum</th><th>DNS</th><th>HTTP</th><th>SSL</th><th>Gecikme</th></tr></thead>
        <tbody>${regionRows(d.regions)}</tbody>
      </table>
    </div>

    ${
      official
        ? `<h2>Resmi durum sayfası</h2>
      <div class="card stack">
        ${official.ok ? `<div>${official.indicator === 'none' ? badge('up', 'Sorun bildirilmiyor') : badge(official.indicator === 'major' || official.indicator === 'critical' ? 'down' : 'degraded', official.description || 'Sorun bildiriliyor')}</div>` : `<p class="muted">Resmi sayfaya şu an ulaşılamıyor.</p>`}
        ${official.incidents
          .map(
            (i) => `<div><strong>${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a>` : esc(i.title)}</strong>
            <span class="muted small">· ${esc(i.status || '')} ${i.updatedAt ? `· ${ago(i.updatedAt)}` : ''}</span>
            ${i.text ? `<p class="small">${esc(i.text.slice(0, 400))}</p>` : ''}</div>`,
          )
          .join('')}
        ${official.pageUrl ? `<p class="small"><a href="${esc(official.pageUrl)}" target="_blank" rel="noopener noreferrer">Resmi sayfayı aç ↗</a> · ${ago(official.fetchedAt)} çekildi</p>` : ''}
      </div>`
        : ''
    }

    <h2>Takip et</h2>
    <p>${esc(d.service.name)} durumu değiştiğinde <a href="/gelistiriciler?servis=${esc(slug)}" data-link>e-posta veya webhook ile haber al</a>${d.components ? ' ya da <a href="/oyunlar" data-link>Discord botunu</a> sunucuna ekle' : ''}.
    API: <code>GET /api/v1/status/${esc(slug)}</code></p>
  `;

  const reportPanel = view.querySelector('#report-panel');
  view.querySelector('#report-open').addEventListener('click', () => {
    reportPanel.classList.remove('hidden');
    reportPanel.querySelector('select').focus();
  });
  view.querySelector('#report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const msg = view.querySelector('#report-msg');
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    store('isp', form.get('isp') || '');
    try {
      const r = await api('/ui/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, isp: form.get('isp') || undefined, component: form.get('component') || undefined }),
      });
      msg.textContent = r.accepted ? 'Teşekkürler, bildirimin alındı.' : r.reason;
      if (r.accepted) setTimeout(() => renderService(slug).catch(() => {}), 1200);
    } catch (err) {
      msg.textContent = err.message;
      btn.disabled = false;
    }
  });
  view.querySelector('#check-open').addEventListener('click', () => runCheck(d));

  refreshTimer = setInterval(() => {
    const busy = !reportPanel.classList.contains('hidden') || !view.querySelector('#check-panel').classList.contains('hidden');
    if (!busy && document.visibilityState === 'visible') renderService(slug).catch(() => {});
  }, 60_000);
}

// --- "Sadece ben miyim?" testi -------------------------------------------------
async function timed(promise, ms) {
  const started = performance.now();
  let timer;
  try {
    const value = await Promise.race([promise, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('zaman aşımı')), ms)))]);
    return { ok: true, value, ms: Math.round(performance.now() - started) };
  } catch (err) {
    return { ok: false, error: err.message, ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

async function dohResolve(host) {
  const tries = [
    ['Cloudflare', `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`],
    ['Google', `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`],
  ];
  const results = await Promise.all(
    tries.map(async ([name, url]) => {
      const r = await timed(fetch(url, { headers: { accept: 'application/dns-json' } }).then((res) => res.json()), 5000);
      if (!r.ok) return { name, reachable: false };
      const answers = (r.value.Answer || []).filter((a) => a.type === 1 || a.type === 5);
      return { name, reachable: true, resolved: r.value.Status === 0 && answers.length > 0 };
    }),
  );
  return {
    reachable: results.some((r) => r.reachable),
    resolved: results.some((r) => r.resolved),
    results,
  };
}

function explain({ online, dns, device, server }) {
  const name = server.name;
  const serverBad = server.state === 'down' || server.state === 'degraded';
  if (!online)
    return ['down', 'İnternet bağlantın yok gibi görünüyor', 'Bizim sitemize bile ulaşamadık. Wi-Fi veya mobil verini kontrol et, modemi yeniden başlatmayı dene.'];
  if (serverBad && !device.ok)
    return ['down', 'Sorun sende değil', `${name} şu anda başkaları için de ${server.state === 'down' ? 'çökmüş' : 'sorunlu'} görünüyor. Yapabileceğin bir şey yok; düzelince bu sayfa yeşile döner.`];
  if (serverBad && device.ok)
    return ['degraded', 'Sitesi açılıyor ama genel bir sorun var', `${name} adresine senin cihazından ulaşılabiliyor, ancak ölçümlerimiz ve kullanıcı bildirimleri bir sorun gösteriyor. Giriş, ödeme veya uygulama gibi belirli bir özellik etkilenmiş olabilir.`];
  if (!device.ok && dns.reachable && !dns.resolved)
    return ['degraded', 'Alan adı çözümlenemiyor', `${name} için genel DNS sunucuları da cevap vermiyor. Bu genellikle servisin kendi tarafındaki bir DNS sorunudur.`];
  if (!device.ok)
    return ['degraded', 'Görünüşe göre yalnızca sende', `${name} bizim ölçüm noktalarımızdan çalışıyor ama senin cihazından bağlanılamadı. Muhtemel nedenler: internet sağlayıcın, DNS ayarların, VPN/güvenlik duvarı ya da reklam engelleyici. Dene: (1) modemi yeniden başlat, (2) DNS'i 1.1.1.1 veya 8.8.8.8 yap, (3) mobil veri ile dene, (4) VPN'i kapat/aç.`];
  return ['up', 'Sana açık görünüyor', `${name} adresine hem senden hem bizden ulaşılabiliyor. Sorun yaşıyorsan uygulamayı kapatıp aç, önbelleği temizle veya çıkış yapıp tekrar giriş yap. Sorun sürüyorsa "Bende de çalışmıyor" ile bildir.`];
}

async function runCheck(d) {
  const panel = view.querySelector('#check-panel');
  panel.classList.remove('hidden');
  const steps = [
    ['online', 'İnternet bağlantın'],
    ['dns', 'Alan adı çözümleme (genel DNS)'],
    ['device', `Cihazından ${d.host} adresine bağlantı`],
    ['server', 'Ölçüm noktalarımız'],
  ];
  panel.innerHTML = `<h2 style="margin-top:0">Sadece ben miyim?</h2>
    <ul class="steps">${steps.map(([k, t]) => `<li id="step-${k}"><span class="ico">⏳</span><span><strong>${esc(t)}</strong><br><span class="muted small">kontrol ediliyor…</span></span></li>`).join('')}</ul>
    <div id="verdict"></div>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const mark = (k, ok, text) => {
    const li = panel.querySelector(`#step-${k}`);
    li.querySelector('.ico').textContent = ok === null ? '➖' : ok ? '✅' : '❌';
    li.querySelector('.muted').textContent = text;
  };

  const ping = await timed(fetch(`/ui/ping?t=${Date.now()}`, { cache: 'no-store' }), 5000);
  const online = ping.ok && ping.value.ok;
  mark('online', online, online ? `Bağlısın (${ping.ms} ms)` : 'Sunucumuza ulaşılamadı');

  const [dns, device] = await Promise.all([
    online ? dohResolve(d.host) : Promise.resolve({ reachable: false, resolved: false }),
    online ? timed(fetch(`https://${d.host}/`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', redirect: 'follow' }), 8000) : Promise.resolve({ ok: false, error: 'çevrimdışı' }),
  ]);
  mark('dns', dns.reachable ? dns.resolved : null, !dns.reachable ? 'Genel DNS sunucularına ulaşılamadı (ağın engelliyor olabilir)' : dns.resolved ? 'Alan adı çözümleniyor' : 'Alan adı çözümlenemedi');
  mark('device', device.ok, device.ok ? `Bağlantı kuruldu (${device.ms} ms)` : `Bağlanılamadı (${device.error === 'zaman aşımı' ? 'zaman aşımı' : 'bağlantı hatası'})`);

  const up = d.regions.filter((r) => r.state === 'up').length;
  const measured = d.regions.filter((r) => r.state).length;
  mark('server', d.status.state === 'up' ? true : d.status.state === 'unknown' ? null : false, `${STATE[d.status.state]} · ${measured} bölgeden ${up} tanesi sorunsuz`);

  const [state, title, text] = explain({ online, dns, device, server: { ...d.status, name: d.service.name } });
  panel.querySelector('#verdict').innerHTML = `<div class="notice ${state}"><strong>${esc(title)}</strong><p style="margin-bottom:0">${esc(text)}</p></div>
    <p class="small muted">Not: Tarayıcı testleri reklam engelleyiciler veya kurumsal ağ filtrelerinden etkilenebilir. Testte hiçbir kişisel veri saklanmaz.</p>`;
}

// --- Oyunlar -----------------------------------------------------------------
async function renderGames() {
  document.title = 'Oyun sunucuları çöktü mü? — ÇöktüMü?';
  const d = await api('/ui/games');
  view.innerHTML = `
    <section class="hero"><h1>Oyunlar</h1><p class="muted">Giriş, eşleştirme ve mağaza durumları ayrı ayrı: resmi kaynaklardan ve oyuncu bildirimlerinden.</p></section>
    <section class="card">
      <h2 style="margin-top:0">Discord botu</h2>
      <p>Sunucuna ekle, <code>/takip oyun:Valorant</code> yaz; oyun çöktüğünde veya düzeldiğinde kanala mesaj atsın. <code>/durum</code> ile anlık durumu sor.</p>
      ${
        d.discordInstallUrl
          ? `<a class="btn primary" href="${esc(d.discordInstallUrl)}" target="_blank" rel="noopener noreferrer">Discord sunucuna ekle</a>`
          : `<p class="muted small">Bot bu kurulumda henüz yapılandırılmamış. Alternatif: bir kanal webhook'u oluşturup <a href="/gelistiriciler" data-link>webhook aboneliği</a> olarak ekleyebilirsin; mesajlar Discord biçiminde gelir.</p>`
      }
    </section>
    <h2>Durumlar</h2>
    <div class="grid">${d.games
      .map(
        (g) => `<a class="card" href="/s/${esc(g.slug)}" data-link style="color:inherit">
        <div class="row" style="padding:0 0 8px"><strong>${esc(g.name)}</strong>${badge(g.state)}</div>
        ${g.components.map((c) => `<div class="row small" style="padding:2px 0"><span>${esc(c.label)}</span><span class="dot ${esc(c.state)}" title="${esc(STATE[c.state])}"></span></div>`).join('')}
      </a>`,
      )
      .join('')}</div>`;
  refreshTimer = setInterval(() => document.visibilityState === 'visible' && renderGames().catch(() => {}), 60_000);
}

// --- Altyapı / bağımlılıklar ---------------------------------------------------
async function renderDependencies() {
  document.title = 'Altyapı servisleri durumu — ÇöktüMü?';
  const d = await api('/ui/dependencies');
  const cell = (st) => (st ? `<td><span class="dot ${esc(st)}" title="${esc(STATE[st])}" style="display:inline-block"></span></td>` : '<td class="muted">—</td>');
  view.innerHTML = `
    <section class="hero"><h1>Altyapı bağımlılıkları</h1>
    <p class="muted">Uygulamanın dayandığı bulut ve geliştirici servisleri: kendi ölçüm noktalarımızdan ve resmi durum sayfalarının bölge bileşenlerinden.</p></section>
    <div class="card table-wrap">
      <table>
        <thead>
          <tr><th rowspan="2">Servis</th><th rowspan="2">Genel</th><th colspan="${d.probeRegions.length}">Bizim ölçümümüz</th><th colspan="${d.regions.length}">Resmi bölge durumu</th></tr>
          <tr>${d.probeRegions.map((r) => `<th>${esc(r.label)}</th>`).join('')}${d.regions.map((r) => `<th>${esc(r.label)}</th>`).join('')}</tr>
        </thead>
        <tbody>${d.services
          .map(
            (s) => `<tr><td><a href="/s/${esc(s.slug)}" data-link>${esc(s.name)}</a></td><td>${badge(s.state)}</td>
            ${d.probeRegions.map((r) => cell(s.measured[r.key])).join('')}
            ${d.regions.map((r) => (s.official ? cell(s.official.regions[r.key]) : '<td class="muted small">resmi veri yok</td>')).join('')}</tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>
    <p class="small muted">Bölgesel bileşeni olmayan resmi sayfalarda (ör. GitHub) genel durum tüm bölgelere uygulanır. JSON: <code>GET /api/v1/dependencies</code></p>`;
  refreshTimer = setInterval(() => document.visibilityState === 'visible' && renderDependencies().catch(() => {}), 60_000);
}

// --- Geliştiriciler ----------------------------------------------------------
async function renderDevelopers() {
  document.title = 'API ve webhook — ÇöktüMü?';
  const home = await api('/ui/home');
  const preselect = new URLSearchParams(location.search).get('servis');
  const origin = location.origin;
  view.innerHTML = `
    <section class="hero"><h1>Geliştiriciler</h1><p class="muted">Herkese açık JSON API, webhook ve e-posta bildirimleri. Hesap gerekmez.</p></section>

    <h2>API</h2>
    <div class="card stack">
      <p>Ücretsiz katman: IP başına <strong>saatte 60 istek</strong>. Kalan hak <code>X-RateLimit-Remaining</code> başlığında.</p>
      <div class="table-wrap"><table class="api-table"><tbody>
        <tr><td><code>GET /api/v1/status/{servis}</code></td><td>Tek servisin durumu, güven, bölgeler, resmi durum</td></tr>
        <tr><td><code>GET /api/v1/services</code></td><td>Tüm katalog ve özet durumlar</td></tr>
        <tr><td><code>GET /api/v1/problems</code></td><td>Şu an sorunlu/çökmüş servisler</td></tr>
        <tr><td><code>GET /api/v1/dependencies</code></td><td>Altyapı servislerinin bölge bazlı durumu</td></tr>
      </tbody></table></div>
      <pre>curl ${esc(origin)}/api/v1/status/github</pre>
      <pre>{
  "service": { "slug": "github", "name": "GitHub", "category": "altyapi", "url": "https://github.com" },
  "status": { "state": "up", "label": "Çalışıyor", "confidence": 0.94, "reasons": ["…"], "since": "…", "updatedAt": "…" },
  "regions": [{ "region": "istanbul", "state": "up", "latencyMs": 182, "dns": {…}, "http": {…}, "ssl": {…} }, …],
  "reports": { "last15m": 0, "last24h": 4, "baselinePer15m": 0.04 },
  "official": { "indicator": "none", "incidents": [] }
}</pre>
      <p class="small muted"><code>state</code>: <code>up</code> | <code>degraded</code> | <code>down</code> | <code>unknown</code></p>
    </div>

    <h2>Takip et: webhook veya e-posta</h2>
    <form id="sub-form" class="card stack">
      <fieldset>
        <legend>Servisler</legend>
        <input type="text" id="sub-filter" placeholder="Filtrele…" aria-label="Servis filtrele" style="margin-bottom:8px">
        <div class="checks" id="sub-checks">${home.services
          .map((s) => `<label data-search="${esc(s.search)}"><input type="checkbox" name="services" value="${esc(s.slug)}" ${s.slug === preselect ? 'checked' : ''}> ${esc(s.name)}</label>`)
          .join('')}</div>
      </fieldset>
      <fieldset>
        <legend>Kanal</legend>
        <label class="radio"><input type="radio" name="kind" value="email" checked> E-posta</label>
        <label class="radio"><input type="radio" name="kind" value="webhook"> Webhook</label>
      </fieldset>
      <div>
        <label for="sub-target" id="sub-target-label">E-posta adresi</label>
        <input id="sub-target" type="email" required placeholder="ornek@eposta.com">
      </div>
      <div><button class="primary" type="submit">Abone ol</button></div>
      <div id="sub-msg" role="status"></div>
    </form>

    <h2>Webhook biçimi</h2>
    <div class="card stack">
      <p>Durum değiştiğinde (ör. Çalışıyor → Çökmüş) adresine <code>POST</code> atılır. Discord kanal webhook'ları otomatik olarak Discord mesajı biçiminde gönderilir.</p>
      <pre>{
  "event": "status.changed",
  "service": { "slug": "discord", "name": "Discord", "category": "sosyal" },
  "previous": { "state": "up", "label": "Çalışıyor" },
  "current": { "state": "down", "label": "Çökmüş", "confidence": 0.92, "reasons": ["…"] },
  "at": "2026-10-20T21:03:00.000Z",
  "url": "${esc(origin)}/s/discord"
}</pre>
      <p>İmza: <code>X-CoktuMu-Signature: sha256=HMAC_SHA256(secret, gövde)</code></p>
      <pre>import { createHmac, timingSafeEqual } from 'node:crypto';
const expected = 'sha256=' + createHmac('sha256', SECRET).update(rawBody).digest('hex');
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-coktumu-signature']));</pre>
    </div>`;

  const form = view.querySelector('#sub-form');
  const target = view.querySelector('#sub-target');
  const label = view.querySelector('#sub-target-label');
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'kind') return;
    const webhook = e.target.value === 'webhook';
    target.type = webhook ? 'url' : 'email';
    target.placeholder = webhook ? 'https://ornek.com/hook veya Discord webhook URL' : 'ornek@eposta.com';
    label.textContent = webhook ? 'Webhook adresi (https)' : 'E-posta adresi';
  });
  view.querySelector('#sub-filter').addEventListener('input', (e) => {
    const q = normalize(e.target.value);
    for (const l of view.querySelectorAll('#sub-checks label')) l.classList.toggle('hidden', q && !l.dataset.search.includes(q));
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const services = data.getAll('services');
    const msg = view.querySelector('#sub-msg');
    if (!services.length) {
      msg.innerHTML = '<div class="notice degraded">En az bir servis seç.</div>';
      return;
    }
    const kind = data.get('kind');
    try {
      const r = await api('/api/v1/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ services, [kind]: target.value }),
      });
      msg.innerHTML =
        kind === 'webhook'
          ? `<div class="notice up"><strong>Webhook eklendi.</strong><p>İmza anahtarın (yalnızca bir kez gösterilir):</p><pre>${esc(r.secret)}</pre><p class="small">Aboneliği bitirmek için: <a href="${esc(r.unsubscribeUrl)}">${esc(r.unsubscribeUrl)}</a></p></div>`
          : `<div class="notice up">${esc(r.message)}</div>`;
    } catch (err) {
      msg.innerHTML = `<div class="notice down">${esc(err.message)}</div>`;
    }
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
router();
