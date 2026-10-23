#!/usr/bin/env node
'use strict';
/*
 * Build studio.html: one self-contained page that runs the whole stroke-paint
 * pipeline in the browser (no Node, no server, no network).
 *
 *   node scripts/build-studio.js
 *
 * It inlines:
 *   scripts/core.js        the pipeline (same file the CLI uses)
 *   templates/player.html  the player, as a JS string
 *   examples/sample.jpg    the "try the demo image" sample
 *
 * Run it again after editing any of those.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(__dirname, 'studio.shell.html'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
const player = fs.readFileSync(path.join(ROOT, 'templates', 'player.html'), 'utf8');
const samplePath = path.join(ROOT, 'examples', 'sample.jpg');
const sample = fs.existsSync(samplePath) ? fs.readFileSync(samplePath).toString('base64') : '';

// JSON.stringify keeps "</script>" intact, which would close the host <script> early
const safeJson = s => JSON.stringify(s).replace(/<\/script/gi, '<\\/script');

// guard: the core must not slip in a stray closing tag either
if (/<\/script/i.test(core)) throw new Error('core.js contains a </script> sequence');

const out = shell
  .split('/*__CORE__*/').join(core)
  .split('__PLAYER_TPL__').join(safeJson(player))
  .split('__SAMPLE__').join(sample);

const dest = path.join(ROOT, 'studio.html');
fs.writeFileSync(dest, out);

const kb = n => Math.round(n / 1024);
console.log(`studio.html  ${kb(out.length)} KB  (shell ${kb(shell.length)} + core ${kb(core.length)} + player ${kb(player.length)} + sample ${kb(sample.length)})`);
