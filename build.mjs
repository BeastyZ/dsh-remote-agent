// Build the self-contained browser half.
//
// The DSH client loader hands a package's client.js to the page as a classic
// script. We therefore emit one IIFE (React itself stays external and is handed
// in by the loader), then append the __ModuleLoader__.load registration.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

const result = await build({
  absWorkingDir: root,
  entryPoints: ['client-src/app.jsx'],
  bundle: true,
  format: 'iife',
  globalName: '__DSH_REMOTE_AGENT__',
  outfile: 'client-src/.bundle.js',
  jsxFactory: 'h',
  loader: { '.css': 'text' },
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

const bundle = readFileSync(path.join(root, 'client-src/.bundle.js'), 'utf8');

const wrapper = `

// ---- DSH client module registration ---------------------------------------
(function () {
  var host = window.__DSH_REMOTE_AGENT__;
  if (!host || typeof host.createPlugin !== 'function') {
    console.error('[dsh-remote-agent] bundle did not export createPlugin');
    return;
  }
  window.__ModuleLoader__.load({
    id: 'dsh-remote-agent',
    factory: function (require) {
      var React = require('react');
      var ReactDOM = null;
      try { ReactDOM = require('react-dom'); } catch (error) { ReactDOM = null; }
      return host.createPlugin(React, ReactDOM);
    },
  });
})();
`;

const footer = '\n//# sourceURL=dsh-remote-agent/client.js\n';
writeFileSync(path.join(root, 'client.js'), bundle + wrapper + footer);
console.log('[build] client.js written:', (bundle.length / 1024).toFixed(1), 'KiB');
