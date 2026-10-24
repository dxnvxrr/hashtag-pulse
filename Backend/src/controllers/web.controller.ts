import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { config, isProduction } from '../config.js';

/**
 * Serves the playable web client (Web/) at /play. A fixed allow-list of files — no path joins from user input,
 * so there is no directory traversal surface. The page gets its own CSP: scripts and API calls same-origin only.
 */
const FILES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'game.js': 'text/javascript; charset=utf-8',
  'core.js': 'text/javascript; charset=utf-8',
  'store.js': 'text/javascript; charset=utf-8',
  'api.js': 'text/javascript; charset=utf-8',
  'progress.js': 'text/javascript; charset=utf-8',
  'backgrounds.js': 'text/javascript; charset=utf-8',
  'music.js': 'text/javascript; charset=utf-8',
  'social.js': 'text/javascript; charset=utf-8',
  'board.js': 'text/javascript; charset=utf-8',
  'native.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'privacy.html': 'text/html; charset=utf-8',
};

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Hosts Google's H5 Games Ads needs when WEB_AD_CLIENT is set (script, ad iframes, beacons, creatives).
const AD_HOSTS = 'https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://*.gstatic.com https://*.googleadservices.com https://*.adtrafficquality.google';

function pageCsp(ads: boolean): string {
  return [
    "default-src 'none'",
    `script-src 'self'${ads ? ` ${AD_HOSTS}` : ''}`,
    // Ad creatives inject inline styles; without ads the page needs none.
    `style-src 'self'${ads ? " 'unsafe-inline'" : ''} https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com',
    `connect-src 'self'${ads ? ` ${AD_HOSTS}` : ''}`,
    `img-src 'self' data:${ads ? ' https:' : ''}`,
    ads ? `frame-src ${AD_HOSTS}` : "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export async function webController(app: FastifyInstance): Promise<void> {
  if (!config.WEB_ROOT) return;
  const root = resolve(config.WEB_ROOT);
  const noLimit = { config: { rateLimit: false as const } };

  const ads = /^ca-pub-\d{10,20}$/.test(config.WEB_AD_CLIENT);
  const csp = pageCsp(ads);
  // Files are read and gzipped once in production (they're immutable in the image); re-read each time in development.
  const cache = new Map<string, { raw: Buffer; gz: Buffer }>();

  const load = async (name: string) => {
    const hit = cache.get(name);
    if (hit) return hit;
    let raw = await readFile(resolve(root, name));
    if (name === 'privacy.html') {
      raw = Buffer.from(
        raw
          .toString('utf8')
          .replaceAll('{{PUBLISHER}}', escapeHtml(config.PUBLISHER_NAME || 'the publisher (not configured)'))
          .replaceAll('{{CONTACT}}', escapeHtml(config.CONTACT_EMAIL || 'not-configured@example.com'))
          .replaceAll('{{UPDATED}}', '24 October 2026'),
      );
    }
    if (name === 'index.html' && ads) {
      // The client turns ads on when it finds this tag (Web/game.js loadAdNetwork).
      raw = Buffer.from(raw.toString('utf8').replace('<!--ARTIFACT-HEAD-START-->', `<meta name="omt-ad-client" content="${config.WEB_AD_CLIENT}">\n<!--ARTIFACT-HEAD-START-->`));
    }
    const entry = { raw, gz: gzipSync(raw, { level: 9 }) };
    if (isProduction) cache.set(name, entry);
    return entry;
  };

  const send = async (name: string, req: FastifyRequest, reply: FastifyReply) => {
    const type = FILES[name];
    if (!type) return reply.code(404).send({ error: 'not_found' });
    const { raw, gz } = await load(name);
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    reply
      .header('content-type', type)
      .header('content-security-policy', csp)
      .header('cache-control', 'no-cache')
      .header('vary', 'accept-encoding');
    if (gzip) reply.header('content-encoding', 'gzip');
    return reply.send(gzip ? gz : raw);
  };

  app.get('/', noLimit, async (_req, reply) => reply.redirect('/play/'));
  app.get('/privacy', noLimit, async (req, reply) => send('privacy.html', req, reply));

  // Challenge links (https://<this host>/play/#c-…) open the installed app instead of the browser.
  if (config.APPLE_TEAM_ID && config.APPLE_BUNDLE_ID) {
    const aasa = { applinks: { details: [{ appIDs: [`${config.APPLE_TEAM_ID}.${config.APPLE_BUNDLE_ID}`], components: [{ '/': '/play/*' }] }] } };
    app.get('/.well-known/apple-app-site-association', noLimit, async (_req, reply) => reply.type('application/json').send(aasa));
  }
  if (config.ANDROID_CERT_SHA256 && config.GOOGLE_PLAY_PACKAGE_NAME) {
    const links = [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: config.GOOGLE_PLAY_PACKAGE_NAME, sha256_cert_fingerprints: [config.ANDROID_CERT_SHA256.toUpperCase()] },
      },
    ];
    app.get('/.well-known/assetlinks.json', noLimit, async (_req, reply) => reply.type('application/json').send(links));
  }
  app.get('/play', noLimit, async (_req, reply) => reply.redirect('/play/'));
  app.get('/play/', noLimit, async (req, reply) => send('index.html', req, reply));
  app.get<{ Params: { file: string } }>('/play/:file', noLimit, async (req, reply) => send(req.params.file, req, reply));
}
