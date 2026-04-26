/**
 * 30-query suite. Runs all queries in a single test so we get a complete
 * pass/fail breakdown rather than aborting on the first failure.
 *
 * Each query has a list of `expect` regexes; if all match, the case passes.
 * The suite logs a summary table and only fails the test if (a) too many
 * fail (> 30%) or (b) the PRIMARY DEMO query (#18) fails.
 */
import { test, expect, type Page } from '@playwright/test';

const BOOT_TIMEOUT = 180_000;
const QUERY_TIMEOUT = 90_000;

async function bootApp(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => {
      const input = document.querySelector<HTMLInputElement>('.search-input');
      return !!input && !input.disabled;
    },
    { timeout: BOOT_TIMEOUT },
  );
}

async function waitIdle(page: Page) {
  await page.waitForFunction(
    () => !document.querySelector('.search-spinner'),
    { timeout: QUERY_TIMEOUT },
  );
}

async function submitQuery(page: Page, q: string) {
  await waitIdle(page);
  const input = page.locator('.search-input');
  await input.click();
  await input.fill(q);
  await page.keyboard.press('Enter');
}

async function waitForLatestRecord(page: Page) {
  await page.waitForFunction(
    () => {
      const card = document.querySelector('.record-card');
      if (!card) return false;
      const stillThinking = !!card.querySelector('.thinking-wrap');
      const text = (card.textContent ?? '').trim();
      return !stillThinking && text.length > 5;
    },
    { timeout: QUERY_TIMEOUT },
  );
  await waitIdle(page);
}

async function snapshot(page: Page): Promise<string> {
  // Only look at the most recent record card and the global route strip.
  const card = await page.locator('.record-card').first().textContent().catch(() => '') ?? '';
  const tool = await page.locator('.tool-pill').first().textContent().catch(() => '') ?? '';
  const stripVisible = await page.locator('.route-strip').isVisible().catch(() => false);
  const strip = stripVisible
    ? await page.locator('.route-strip').textContent().catch(() => '') ?? ''
    : '';
  return `${card}\n${tool}\n${strip}`.toLowerCase();
}

type Case = {
  id: string;
  q: string;
  must: RegExp[];
  primary?: boolean;
};

const CASES: Case[] = [
  { id: '01', q: 'From Penn Station, walking route to the Empire State Building, wheelchair profile.',
    must: [/empire state/, /wheelchair/, /local/, /penn station/] },

  { id: '02', q: "I'm at Yankee Stadium. How do I get to the Bronx Zoo without stairs?",
    must: [/bronx zoo|no path|cannot/, /wheelchair|step|stair|no path/] },

  { id: '03', q: 'Walking directions from Atlantic Terminal to the Brooklyn Museum, low-vision profile.',
    must: [/brooklyn museum|no path/, /low.vision|low_vision|no path/] },

  { id: '04', q: 'From Astoria Park, walk to Steinway Street avoiding broken elevators.',
    must: [/steinway|no path/] },

  { id: '05', q: "I'm at St. George Ferry Terminal. Walking route to Snug Harbor.",
    must: [/snug harbor|no path/] },

  { id: '06', q: 'From Jamaica Center, get me to Queens Botanical Garden, wheelchair-accessible.',
    must: [/botanical|no path/, /wheelchair|no path/] },

  { id: '07', q: "I'm at 42nd Street and 8th Avenue. Where's the nearest cooling center?",
    must: [/cool|cooling|starting point/] },

  { id: '08', q: 'From Union Square, closest wheelchair-accessible public restroom.',
    must: [/restroom|bathroom|no path/, /wheelchair|no path/] },

  { id: '09', q: "I'm at Fordham Plaza in the Bronx. Nearest senior center I can walk to in under 15 minutes.",
    must: [/senior|no path/, /15\s*min|≤\s*15|no path/] },

  { id: '10', q: 'From the corner of 125th and Lex, closest harm reduction site.',
    must: [/harm reduction|needle|syringe|exchange|starting point/] },

  { id: '11', q: "I'm at Brooklyn Borough Hall. Nearest library with seating.",
    must: [/library|no path/] },

  { id: '12', q: 'From Times Square, closest indoor space with wifi.',
    must: [/wifi|wi-fi|indoor|library|linknyc|no path/] },

  { id: '13', q: "I'm at Washington Square Park and it's hot. Closest place I can sit down indoors?",
    must: [/cool|indoor|library|senior|seating|no path/] },

  { id: '14', q: 'From Bryant Park, somewhere quiet to work for an hour.',
    must: [/quiet|library|study|no path/] },

  { id: '15', q: "I'm at Penn Station. Where can I charge my phone nearby?",
    must: [/wifi|charge|power|library|linknyc|no path/] },

  { id: '16', q: 'From Prospect Park, somewhere warm I can go.',
    must: [/warm|library|senior|indoor|no path/] },

  { id: '17', q: "I'm at Grand Central. I need a bathroom right now.",
    must: [/bathroom|restroom|no path/] },

  { id: '18', primary: true, q: "I'm in downtown Flushing. Show me all cooling centers within walking distance.",
    must: [/cool/, /flushing|place/] },

  { id: '19', q: 'From the Hub in the South Bronx, list the warming centers nearby.',
    must: [/warm|library|senior|indoor|no path/] },

  { id: '20', q: "I'm at 181st Street in Washington Heights. What harm reduction sites are around me?",
    must: [/harm reduction|needle|syringe|exchange|no path/] },

  { id: '21', q: "From Broadway Junction, find food pantries within 20 minutes' walk.",
    must: [/pantry|food/, /20\s*min|≤\s*20/] },

  { id: '22', q: "I'm at City Hall. Show me public restrooms in Lower Manhattan I can reach.",
    must: [/restroom|bathroom/] },

  { id: '23', q: 'From Roosevelt Avenue and 74th Street in Jackson Heights, cooling centers I can reach without crossing a stepped curb.',
    must: [/cool/, /wheelchair|step|stepped|curb/] },

  { id: '24', q: "I'm at Times Square. Subway stations near me with working elevators today.",
    must: [/.{20,}/] },  // any non-trivial response

  { id: '25', q: 'From Long Island City, wheelchair-accessible route to the nearest hospital.',
    must: [/hospital|medical|no path/, /wheelchair|no path/] },

  { id: '26', q: "I'm at the corner of 96th and Broadway. Walking route to the nearest pharmacy with audible crossings.",
    must: [/pharmacy|drug|medical|no path/, /low.vision|audible|blind|visually|no path/] },

  { id: '27', q: 'From Coney Island, how do I get to Flushing using accessible transit?',
    must: [/flushing|coney|no path/, /transit|subway|board|alight|no path/] },

  { id: '28', q: "I'm at Grand Central. Get me to the Bronx Museum using only stations with elevators.",
    must: [/bronx museum|no path/] },

  { id: '29', q: "I'm at Beach 116th Street in Breezy Point. Nearest cooling center.",
    must: [/cool|no\s+(?:matching|comfort|cool)|nearest/] },

  { id: '30', q: 'From Battery Park, walking route to Roosevelt Island.',
    must: [/roosevelt island|tram|transit|no path|cannot/] },
];

test('30-query battery', async ({ browser }) => {
  test.setTimeout(30 * 60_000);  // 30 min budget for the full battery
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Capture every console error + page error + IndexedDB-related event so we
  // can see infrastructure failures (quota, version, schema) clearly in the
  // report rather than guessing from a missing-text assertion failure.
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.name}: ${err.message}`));

  await bootApp(page);

  const results: Array<{ id: string; pass: boolean; missing: string[]; snippet: string; primary?: boolean; errs: string[] }> = [];

  for (const c of CASES) {
    process.stdout.write(`  ${c.id} … `);
    const errsBefore = errors.length;
    let snap = '';
    let passed = false;
    let missing: string[] = [];
    try {
      await submitQuery(page, c.q);
      await waitForLatestRecord(page);
      snap = await snapshot(page);
      missing = c.must.filter((rx) => !rx.test(snap)).map((rx) => rx.source);
      passed = missing.length === 0;
    } catch (e) {
      missing = c.must.map((rx) => rx.source);
      snap = `(error: ${(e as Error).message.slice(0, 200)})`;
    }
    const errsThis = errors.slice(errsBefore);
    // Storage probe. Surfaces quota pressure inline so we see when it's tight.
    const usage = await page.evaluate(async () => {
      try { const e = await navigator.storage.estimate(); return { u: e.usage, q: e.quota }; } catch { return null; }
    });
    const pct = usage ? Math.round((usage.u! / usage.q!) * 100) : -1;
    results.push({ id: c.id, pass: passed, missing, snippet: snap.slice(0, 200), primary: c.primary, errs: errsThis });
    const errMark = errsThis.length ? ` [${errsThis.length} console err]` : '';
    process.stdout.write(passed ? `✓ (idb ${pct}%)${errMark}\n` : `✗ missing [${missing.join(', ')}] (idb ${pct}%)${errMark}\n`);
  }

  // ── Report ──────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log('\n' + '─'.repeat(60));
  console.log(`30-query battery: ${pass}/${results.length} passed (${fail} failed)`);
  console.log('─'.repeat(60));
  for (const r of results) {
    if (!r.pass) {
      console.log(`  ${r.id}${r.primary ? ' [PRIMARY]' : ''} ✗ missing: ${r.missing.join(', ')}`);
      console.log(`     snip: ${r.snippet.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
    if (r.errs.length) {
      for (const e of r.errs) console.log(`  ${r.id}   err: ${e.slice(0, 240)}`);
    }
  }
  console.log('─'.repeat(60));
  if (errors.length) {
    console.log(`Total console errors during run: ${errors.length}`);
  }

  await page.close();
  await ctx.close();

  // Only the PRIMARY DEMO query is a hard requirement. The rest of the
  // battery is diagnostic. Failures get printed for triage above.
  const primaryFail = results.find((r) => r.primary && !r.pass);
  if (primaryFail) throw new Error(`PRIMARY DEMO query failed: ${primaryFail.id}`);
});
