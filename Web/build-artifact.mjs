// Bundles the web client into one self-contained HTML body (no external JS/CSS files) for hosting as a
// claude.ai Artifact or any static host. Usage: node Web/build-artifact.mjs <out.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(dir, 'dist', 'one-more-tap.html');
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const css = readFileSync(join(dir, 'style.css'), 'utf8');
const core = readFileSync(join(dir, 'core.js'), 'utf8').replace(/^export /gm, '');
const stripImports = (src) => src.replace(/^import \{[\s\S]*?\} from '\.\/[a-z]+\.js';\n/gm, '');
const backgrounds = stripImports(readFileSync(join(dir, 'backgrounds.js'), 'utf8')).replace(/^export /gm, '');
const game = stripImports(readFileSync(join(dir, 'game.js'), 'utf8'));

const between = (start, end) => html.slice(html.indexOf(start) + start.length, html.indexOf(end));
const head = between('<!--ARTIFACT-HEAD-START-->', '<!--ARTIFACT-HEAD-END-->').replace('<link rel="stylesheet" href="style.css">', `<style>\n${css}</style>`);
const body = between('<!--ARTIFACT-BODY-START-->', '<!--ARTIFACT-BODY-END-->');

writeFileSync(out, `${head.trim()}\n${body.trim()}\n<script type="module">\n${core}\n${backgrounds}\n${game}</script>\n`);
console.log(`wrote ${out}`);
