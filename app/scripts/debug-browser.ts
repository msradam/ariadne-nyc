/**
 * One-shot Playwright debug harness. Boots the dev server, captures every
 * console message + page error + IndexedDB-related event, runs a single
 * query, and prints the full capture.
 *
 * Usage:
 *   npx tsx scripts/debug-browser.ts                    # default query
 *   npx tsx scripts/debug-browser.ts "your query here"  # custom
 *
 * Run with HEADED=1 to watch the browser; default is headless w/ swiftshader.
 */
import { chromium, type ConsoleMessage } from '@playwright/test';

const HEADED = process.env.HEADED === '1';
const QUERY = process.argv[2] || "I'm in downtown Flushing. Show me all cooling centers within walking distance.";

async function main() {
  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--enable-features=Vulkan,SharedArrayBuffer',
      '--enable-webgpu-developer-features',
      '--use-vulkan=swiftshader',
      ...(HEADED ? [] : ['--enable-unsafe-swiftshader']),
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // ── Capture everything ──────────────────────────────────────────────
  const events: { time: number; kind: string; text: string; loc?: string }[] = [];
  const t0 = Date.now();
  const log = (kind: string, text: string, loc?: string) => {
    events.push({ time: Date.now() - t0, kind, text, loc });
  };

  page.on('console', (msg: ConsoleMessage) => {
    const loc = msg.location();
    log(`console.${msg.type()}`, msg.text(), `${loc.url}:${loc.lineNumber}`);
  });
  page.on('pageerror', (err) => log('pageerror', `${err.name}: ${err.message}\n${err.stack ?? ''}`));
  page.on('requestfailed', (req) => log('requestfailed', `${req.method()} ${req.url()}. ${req.failure()?.errorText}`));
  page.on('response', (resp) => {
    if (resp.status() >= 400) log('http_error', `${resp.status()} ${resp.url()}`);
  });

  console.log(`booting → http://localhost:5173/  (headless=${!HEADED})`);
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wait until input becomes enabled (boot finished) OR a fatal error fires
  console.log('waiting for boot...');
  try {
    await page.waitForFunction(
      () => {
        const i = document.querySelector<HTMLInputElement>('.search-input');
        return !!i && !i.disabled;
      },
      { timeout: 180_000 },
    );
    console.log(`boot ok at +${Date.now() - t0}ms`);
  } catch (e) {
    console.error(`boot timed out: ${(e as Error).message}`);
  }

  // Probe IndexedDB state directly
  const idbState = await page.evaluate(async () => {
    const out: Record<string, unknown> = {
      crossOriginIsolated: (self as any).crossOriginIsolated,
      hasIndexedDB: typeof indexedDB !== 'undefined',
    };
    if ('databases' in indexedDB) {
      try {
        const dbs = await (indexedDB as any).databases();
        out.databases = dbs.map((d: any) => ({ name: d.name, version: d.version }));
      } catch (e) {
        out.databases_error = String(e);
      }
    }
    if (navigator.storage && navigator.storage.estimate) {
      try {
        out.storage = await navigator.storage.estimate();
      } catch (e) {
        out.storage_error = String(e);
      }
    }
    return out;
  });
  console.log('\nIndexedDB state:', JSON.stringify(idbState, null, 2));

  // Submit the query
  console.log(`\nsubmitting query: ${QUERY}`);
  await page.locator('.search-input').fill(QUERY);
  await page.keyboard.press('Enter');

  // Wait until busy indicator clears, OR 90s
  try {
    await page.waitForFunction(
      () => !document.querySelector('.search-spinner'),
      { timeout: 90_000 },
    );
    console.log(`query settled at +${Date.now() - t0}ms`);
  } catch (e) {
    console.error(`query timed out: ${(e as Error).message}`);
  }

  // Snapshot the active record
  const card = await page.locator('.record-card').first().textContent().catch(() => '(no card)');
  console.log('\nActive record card:\n', (card ?? '').trim().slice(0, 500));

  // Print all captured events
  console.log('\n' + '─'.repeat(70));
  console.log(`Captured ${events.length} events:`);
  console.log('─'.repeat(70));
  for (const e of events) {
    const ts = String(e.time).padStart(6, ' ');
    const kind = e.kind.padEnd(20, ' ');
    console.log(`+${ts}ms  ${kind}  ${e.text.replace(/\n/g, '\n                                  ')}`);
    if (e.loc && /\.svelte|\.ts/.test(e.loc)) console.log(`                                  @ ${e.loc}`);
  }

  if (HEADED) {
    console.log('\n[HEADED mode. Leaving browser open. Press Ctrl-C when done.]');
    await new Promise(() => {});
  } else {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
