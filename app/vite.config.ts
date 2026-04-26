import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { createReadStream, statSync } from 'node:fs';
import { resolve as pathResolve, normalize } from 'node:path';

// Serve Granite 4 model shards from <repo>/models/granite-1b/ (populated by
// scripts/setup-model.sh). WebLLM constructs HuggingFace-style URLs (with
// resolve/main/). Strip them.
function granitePlugin(modelRoot: string): Plugin {
  const abs = pathResolve(modelRoot);
  return {
    name: 'granite-model',
    configureServer(server) {
      server.middlewares.use('/granite-1b', (req, res, next) => {
        try {
          let url = (req.url || '/').split('?')[0];
          url = url.replace(/^(\/?)(resolve\/main\/)+/g, '/');
          const safe = normalize(url).replace(/^(\/\.\.)+/, '');
          const file = pathResolve(abs, '.' + safe);
          if (!file.startsWith(abs)) { res.statusCode = 403; res.end('forbidden'); return; }
          const st = statSync(file);
          if (st.isDirectory()) { next(); return; }
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Length', String(st.size));
          if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
          else if (file.endsWith('.json')) res.setHeader('Content-Type', 'application/json');
          else if (file.endsWith('.bin')) res.setHeader('Content-Type', 'application/octet-stream');
          createReadStream(file).pipe(res);
        } catch { next(); }
      });
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit(),
    // Model lives at <repo>/models/granite-1b. Populated by scripts/setup-model.sh.
    // From this file (app/vite.config.ts) → ../models/granite-1b
    granitePlugin(pathResolve(__dirname, '../models/granite-1b')),
  ],
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    fs: {
      allow: [
        // Allow Vite to serve files from the whole repo root (data/, models/, router/pkg/).
        pathResolve(__dirname, '..'),
      ],
    },
  },
  optimizeDeps: {
    exclude: ['@mlc-ai/web-llm'],
  },
});
