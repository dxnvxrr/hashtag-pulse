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
  'style.css': 'text/css; charset=utf-8',
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export async function webController(app: FastifyInstance): Promise<void> {
  if (!config.WEB_ROOT) return;
  const root = resolve(config.WEB_ROOT);
  const noLimit = { config: { rateLimit: false as const } };

  const send = async (name: string, reply: import('fastify').FastifyReply) => {
    const type = FILES[name];
    if (!type) return reply.code(404).send({ error: 'not_found' });
    const body = await readFile(resolve(root, name));
    return reply
      .header('content-type', type)
      .header('content-security-policy', PAGE_CSP)
      .header('cache-control', 'no-cache')
      .send(body);
  };

  app.get('/', noLimit, async (_req, reply) => reply.redirect('/play/'));
  app.get('/play', noLimit, async (_req, reply) => reply.redirect('/play/'));
  app.get('/play/', noLimit, async (_req, reply) => send('index.html', reply));
  app.get<{ Params: { file: string } }>('/play/:file', noLimit, async (req, reply) => send(req.params.file, reply));
}
