/* build-app.mjs — drives the repo's real Vite config (React plugin + PWA)
 * from the embedded libnode via the in-process `node <script>` build step.
 * Workbox `generateSW` (a child rollup build in the PWA plugin's closeBundle)
 * hangs at 0% CPU under libnode, so PWA is skipped BY DEFAULT; set
 * POCKET_FULL_PWA=1 to run the original config end-to-end (for reference,
 * will hang on-device).
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'vite';

const appRoot = fileURLToPath(new URL('app', import.meta.url));
const configFile = path.join(appRoot, 'vite.config.js');
const fullPwa = process.env.POCKET_FULL_PWA === '1';
const skipPwa = !fullPwa;
console.log('[vite-real] skipPwa=' + skipPwa + ' cwd=' + process.cwd());

if (skipPwa) {
  const mod = await import(pathToFileURL(configFile).href);
  const cfg = typeof mod.default === 'function' ? await mod.default() : getConfigClone(mod.default);
  cfg.root = appRoot;
  cfg.configFile = false;
  const flat = (Array.isArray(cfg.plugins) ? cfg.plugins : []).flat(3);
  console.log('[vite-real] plugin names: ' +
    flat.map((p) => (p && p.name) || (p && p.constructor && p.constructor.name) || '?').join(', '));
  const before = flat.length;
  const isPwaWrapper = (p) =>
    p && p.name && (String(p.name).startsWith('vite-plugin-pwa') || String(p.name).startsWith('vite:pwa'));
  const kept = flat.filter((p) => !isPwaWrapper(p));
  console.log('[vite-real] plugins before=' + before + ' after=' + kept.length);
  kept.push({
    name: 'pocket-pwa-virtual-modules',
    resolveId(id) {
      if (id === 'virtual:pwa-register' || id === 'virtual:pwa-register/react') return '\0pwa:' + id;
      return null;
    },
    load(id) {
      if (id === '\0pwa:virtual:pwa-register' || id === '\0pwa:virtual:pwa-register/react') {
        return 'export function registerSW() { return function() {}; }';
      }
      return null;
    }
  });
  cfg.plugins = kept;
  cfg.build = cfg.build || {};
  await build(cfg);
} else {
  await build({ root: appRoot, configFile });
}
console.log('[vite-real] build done');

function getConfigClone(c) {
  return c && typeof c === 'object' ? { ...c } : c;
}