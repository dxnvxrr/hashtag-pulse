// Copies the web client (../Web) into www/ for the app and writes the app's settings into index.html as meta tags:
// where the API lives, the public URL challenge links point at, the privacy policy, and the AdMob ad units.
// Settings come from app.config.json. The Google test ad units there are safe to ship to TestFlight, never to the
// store: set "testing": false and your own units before release.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', 'Web');
const www = join(here, 'www');
const cfg = JSON.parse(readFileSync(join(here, 'app.config.json'), 'utf8'));
const FILES = ['index.html', 'style.css', 'core.js', 'store.js', 'native.js', 'api.js', 'progress.js', 'backgrounds.js', 'music.js', 'social.js', 'board.js', 'game.js'];

for (const key of ['apiUrl', 'shareUrl', 'privacyUrl']) {
  if (!/^https:\/\//.test(cfg[key] ?? '')) throw new Error(`app.config.json: ${key} must be an https:// URL`);
}
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const metas = [
  ['omt-api', cfg.apiUrl],
  ['omt-share-url', cfg.shareUrl],
  ['omt-privacy-url', cfg.privacyUrl],
  ['omt-admob-rewarded-ios', cfg.admob?.iosRewarded ?? ''],
  ['omt-admob-rewarded-android', cfg.admob?.androidRewarded ?? ''],
  ['omt-admob-testing', String(cfg.admob?.testing !== false)],
]
  .map(([name, content]) => `<meta name="${name}" content="${esc(content)}">`)
  .join('\n');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const f of FILES) cpSync(join(web, f), join(www, f));
const index = readFileSync(join(www, 'index.html'), 'utf8');
if (!index.includes('<!--ARTIFACT-HEAD-START-->')) throw new Error('Web/index.html is missing its head marker');
writeFileSync(join(www, 'index.html'), index.replace('<!--ARTIFACT-HEAD-START-->', `${metas}\n<!--ARTIFACT-HEAD-START-->`));
console.log(`www/ built from Web/ (${FILES.length} files), API ${cfg.apiUrl}${cfg.admob?.testing !== false ? ', TEST ads' : ''}`);
