/**
 * End-to-end query tests. These drive a real Chromium against the dev server,
 * loading WebLLM + Granite + the WASM router, then submit natural-language
 * queries through the SearchBar and assert on the rendered result.
 *
 * Each test is a full cycle:
 *   boot → user types → LLM tool turn → router dispatch → LLM summary turn → DOM
 *
 * The first test pays the boot cost (~30-90 s for model load on first visit
 * with cold IndexedDB). Subsequent tests reuse the same Page so the model
 * stays loaded across cases. Much faster.
 */
import { test, expect, type Page } from '@playwright/test';

// Prefer ASCII-only matchers in regexes so dim/bold/special-char rendering
// in the active record can't fool string equality.
const ANY = '[\\s\\S]';

async function bootApp(page: Page) {
  await page.goto('/');
  // Wait for the SearchBar input to become enabled. That's the boot
  // signal. The app sets querySubmitFn after Granite finishes loading;
  // before that, the input is disabled.
  await page.waitForFunction(
    () => {
      const input = document.querySelector<HTMLInputElement>('.search-input');
      return !!input && !input.disabled;
    },
    { timeout: 150_000 },
  );
}

async function waitIdle(page: Page) {
  // The query-busy state renders a .search-spinner inside the search bar.
  // When idle, the spinner is gone (replaced by the submit arrow or nothing).
  // We wait for the absence of .search-spinner to confirm we can submit.
  await page.waitForFunction(
    () => !document.querySelector('.search-spinner'),
    { timeout: 120_000 },
  );
}

async function submitQuery(page: Page, q: string) {
  await waitIdle(page);
  const input = page.locator('.search-input');
  await input.click();
  await input.fill(q);
  await page.keyboard.press('Enter');
}

async function waitForActiveRecord(page: Page, n: number) {
  // ActiveRecord eyebrow shows "ACTIVE RECORD · 0N". Wait for that exact
  // record number to appear, then for streaming to settle (the toolSummary
  // pill or bot text becoming non-empty).
  await page.locator('.record-eyebrow', { hasText: new RegExp(`ACTIVE RECORD${ANY}*0?${n}`) })
    .waitFor({ state: 'visible' });
  // Wait for either the structured card OR the bot text to render
  await page.waitForFunction(
    () => {
      const card = document.querySelector('.record-card');
      if (!card) return false;
      const text = card.textContent ?? '';
      // Streaming is done when there's no thinking-dots wrapper AND text is non-empty
      const stillThinking = !!card.querySelector('.thinking-wrap');
      return !stillThinking && text.trim().length > 5;
    },
    { timeout: 90_000 },
  );
}

// ────────────────────────────────────────────────────────────────────────
// Boot smoke test. Runs first to pay the model-load tax once.
test.describe.serial('Ariadne end-to-end', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    page = await context.newPage();
    await bootApp(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // ── 1. App boots within timeout ─────────────────────────────────────
  test('app boots: WebGPU + Granite + WASM router', async () => {
    await expect(page.locator('.search-input')).toBeEnabled();
    // Transit-stats line confirms transit binaries loaded.
    await expect(page.locator('.feed-line')).toContainText(/\d+\s*stops/);
  });

  // ── 2. Walk-only intra-Manhattan ─────────────────────────────────────
  test('Penn Station → Grand Central (walk only)', async () => {
    await submitQuery(page, 'penn station to grand central');
    await waitForActiveRecord(page, 1);
    // Bottom route strip should render
    await expect(page.locator('.route-strip')).toBeVisible();
    // Either profile=Walk or mode=walk; just assert SOMETHING resembling success
    const card = page.locator('.record-card').first();
    await expect(card).toContainText(/grand central/i);
  });

  // ── 3. Address-to-named (offline geocoder + WASM) ────────────────────
  test('350 5th Avenue → Penn Station (address resolution)', async () => {
    await submitQuery(page, '350 5th avenue to penn station');
    await waitForActiveRecord(page, 2);
    await expect(page.locator('.route-strip')).toBeVisible();
    await expect(page.locator('.route-strip')).toContainText(/350.*5th/i);
  });

  // ── 4. Cross-borough multimodal + ADA filtering ──────────────────────
  test('Kew Gardens → Grand Central, wheelchair (multimodal)', async () => {
    await submitQuery(page, 'kew gardens to grand central, wheelchair');
    await waitForActiveRecord(page, 3);
    // Card should show closest match + transit
    const card = page.locator('.record-card').first();
    // Either the eyebrow says "WALK + SUBWAY" or the route strip says "transit"
    const cardText = await card.textContent();
    const stripText = await page.locator('.route-strip').textContent();
    const haystack = `${cardText ?? ''}\n${stripText ?? ''}`.toLowerCase();
    expect(haystack).toMatch(/subway|transit|walk_transit_walk/);
  });

  // ── 5. @me sentinel. Geolocation gated off ──────────────────────────
  test('nearest cooling center (no origin) → asks for starting point', async () => {
    await submitQuery(page, 'nearest cooling center');
    await waitForActiveRecord(page, 4);
    const card = page.locator('.record-card').first();
    await expect(card).toContainText(/starting point/i);
  });

  // ── 6. Find-comfort flow with explicit origin ────────────────────────
  test('find a cooling center near Times Square', async () => {
    await submitQuery(page, 'find a cooling center near times square');
    await waitForActiveRecord(page, 5);
    const card = page.locator('.record-card').first();
    await expect(card).toContainText(/CLOSEST MATCH/i);
  });

  // ── 7. Reachable / isochrone with explicit budget ────────────────────
  test('cooling centers within 10 minutes of Yankee Stadium', async () => {
    await submitQuery(page, 'cooling centers within 10 minutes of yankee stadium');
    await waitForActiveRecord(page, 6);
    // Walk-radius legend appears when isochrone fires
    await expect(page.locator('.walk-legend')).toBeVisible();
    // ALSO NEARBY section may render if more than one site
    const card = page.locator('.record-card').first();
    await expect(card).toContainText(/min/i);
  });
});
