// Slash komutlarını Discord'a kaydeder: DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... npm run discord:register
import { loadCatalog } from '../src/catalog.js';
import { commandDefinitions, INSTALL_PERMISSIONS } from '../src/discord.js';

const { DISCORD_APP_ID: appId, DISCORD_BOT_TOKEN: token } = process.env;
if (!appId || !token) {
  console.error('DISCORD_APP_ID ve DISCORD_BOT_TOKEN gerekli');
  process.exit(1);
}
const games = loadCatalog().services.filter((s) => s.category === 'oyun');
const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: 'PUT',
  headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(commandDefinitions(games)),
});
if (!res.ok) {
  console.error(`Kayıt başarısız: HTTP ${res.status}\n${await res.text()}`);
  process.exit(1);
}
console.log(`${games.length} oyunla komutlar kaydedildi.`);
console.log(`Sunucuya ekleme linki: https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=${INSTALL_PERMISSIONS}`);
