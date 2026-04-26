# Ariadne HF Space Deployment Plan

## Architecture

```
User's browser
  └── downloads model once → IndexedDB cache → WebGPU inference (local, private)

HF Space (static SDK)
  └── serves app HTML/JS/CSS + routing graph + transit data

HF Model Repo (msradam/Granite-4.0-1b-q4f32_1-MLC)
  └── serves model shards via CDN (download source only. Model runs on client GPU)
```

The privacy guarantee: after the first visit, no network calls are made for inference.
Queries, routes, and user location never leave the browser.

## Why a separate model repo

- Space repo stays small (~50MB) → fast redeploys
- Model repo is append-only weights. Deploy independently
- HF CDN handles range requests and caching automatically
- Standard pattern used by MLC AI for all their official WebLLM Spaces

## Steps

### 1. Create HF model repo
- Repo: `msradam/Granite-4.0-1b-q4f32_1-MLC` (already exists; `scripts/setup-model.sh` clones it for local dev)
- Type: model
- Source files live in `<repo>/models/granite-1b/` after running the setup script. That directory mirrors the HF model repo
  - LFS tracked: `*.bin`, `*.wasm` (~893MB total)
  - Plain git: `*.json`, `*.txt` (small config/tokenizer files)
- Exclude: `*.so` (macOS Metal, not needed for WebGPU)

### 2. Update adapter for prod URL
In `src/lib/adapters/llm.ts`, use `import.meta.env.PROD` to switch:
- Dev:  `${origin}/granite-1b/`  (served by Vite plugin from local disk)
- Prod: `https://huggingface.co/msradam/Granite-4.0-1b-q4f32_1-MLC/resolve/main/`

### 3. Add COEP/COOP headers to Space README
HF Spaces natively supports these via `custom_headers` YAML. No service worker needed:
```yaml
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
```

### 4. Build and deploy Space
- `npm run build` (no env vars needed)
- rsync to `/tmp/ariadne-hf-deploy`
- Restore `.gitattributes`, transit binaries
- Commit + push

## Correct rsync command (copy-paste)

```bash
rsync -a --delete \
  --exclude '.git' \
  --exclude '.gitattributes' \
  --exclude 'README.md' \
  --exclude 'output/timetable.bin' \
  --exclude 'output/stops.bin' \
  --exclude 'output/ada-stops.json' \
  app/build/ \
  /tmp/ariadne-hf-deploy/
cd /tmp/ariadne-hf-deploy
git checkout HEAD -- .gitattributes output/timetable.bin output/stops.bin output/ada-stops.json
```

**Issue noted:** `--delete` removes `README.md` (which lives in the deploy repo but not in `build/`).
Fixed by adding `--exclude 'README.md'` to rsync. Without this, COEP/COOP headers disappear on every deploy.

## Known risks / watch points
- WASM MIME type: HF must serve `.wasm` as `application/wasm`. Verify in DevTools
- CORS on model repo: HF model repos are public and CORS-enabled by default
- IndexedDB cache key: if model URL changes, users re-download. Keep URL stable.
- `ndarray-cache.json` must be reachable at the model base URL. WebLLM reads it first
- `tensor-cache.json` / `tensor-cache-b16.json`: include both, WebLLM may need them
