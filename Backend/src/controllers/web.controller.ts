import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config.js';

/**
 * Serves the playable web client (Web/) at /play. A fixed allow-list of files — no path joins from user input,
 * so there is no directory traversal surface. The page gets its own CSP: scripts and API calls same-origin only.
 */
const FILES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'game.js': 'text/javascript; charset=utf-8',
  'core.js': 'text/javascript; charset=utf-8',
  'backgrounds.js': 'text/javascript; charset=utf-8',
  'music.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
};

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

  const send = async (name: string, reply: import('fastify').FastifyReply) => {
    const type = FILES[name];
    if (!type) return reply.code(404).send({ error: 'not_found' });
    let body: Buffer | string = await readFile(resolve(root, name));
    const ads = /^ca-pub-\d{10,20}$/.test(config.WEB_AD_CLIENT);
    if (name === 'index.html' && ads) {
      // The client turns ads on when it finds this tag (Web/game.js loadAdNetwork).
      body = body.toString('utf8').replace('<!--ARTIFACT-HEAD-START-->', `<meta name="omt-ad-client" content="${config.WEB_AD_CLIENT}">\n<!--ARTIFACT-HEAD-START-->`);
    }
    return reply
      .header('content-type', type)
      .header('content-security-policy', pageCsp(ads))
      .header('cache-control', 'no-cache')
      .send(body);
  };

  app.get('/', noLimit, async (_req, reply) => reply.redirect('/play/'));
  app.get('/play', noLimit, async (_req, reply) => reply.redirect('/play/'));
  app.get('/play/', noLimit, async (_req, reply) => send('index.html', reply));
  app.get<{ Params: { file: string } }>('/play/:file', noLimit, async (req, reply) => send(req.params.file, reply));
}
