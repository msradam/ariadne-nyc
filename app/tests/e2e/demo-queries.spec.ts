/**
 * Demo-candidate query battery. Runs the 10 candidate queries the team is
 * choosing from for the live pitch. Captures the full response for each so
 * we can pick the 3 strongest based on real output, not regex assertions.
 *
 * Output: console + test-results/demo-queries-report.md
 */
import { test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const QUERIES = [
  { id: '01', q: "I'm in downtown Flushing. Show me cooling centers within walking distance, wheelchair-accessible." },
  { id: '02', q: "I'm at Fordham Plaza. Find me senior centers I can walk to in under 15 minutes without crossing stepped curbs." },
  { id: '03', q: 'From 125th and Lexington, walk route to the nearest pharmacy with audible crossings and seating.' },
  { id: '04', q: "I'm at Times Square. Find me subway stations with working elevators today and walking-accessible entrances." },
  { id: '05', q: 'From 181st Street in Washington Heights, find harm reduction sites I can reach in under 20 minutes walking.' },
  { id: '06', q: "I'm at Prospect Park. Walking route to the nearest cooling center with wifi." },
  { id: '07', q: 'From Long Island City, wheelchair-accessible route to the Bronx Museum using only stations with elevators.' },
  { id: '08', q: "I'm at Union Square. Closest public restroom with audible signals on the route." },
  { id: '09', q: "I'm at Brooklyn Borough Hall. List libraries within 15 minutes walk that have seating and accessible bathrooms." },
  { id: '10', q: 'Estoy en Jackson Heights, Roosevelt y 74. ¿Dónde está el centro de enfriamiento más cercano?' },
];

const BOOT_TIMEOUT = 180_000;
const QUERY_TIMEOUT = 90_000;

async function bootApp(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const i = document.querySelector<HTMLInputElement>('.search-input');
    return !!i && !i.disabled;
  }, { timeout: BOOT_TIMEOUT });
}

async function waitIdle(page: Page) {
  await page.waitForFunction(() => !document.querySelector('.search-spinner'), { timeout: QUERY_TIMEOUT });
}

async function submitQuery(page: Page, q: string) {
  await waitIdle(page);
  const input = page.locator('.search-input');
  await input.click();
  await input.fill(q);
  await page.keyboard.press('Enter');
}

async function waitForLatestRecord(page: Page) {
  await page.waitForFunction(() => {
    const card = document.querySelector('.record-card');
    if (!card) return false;
    const stillThinking = !!card.querySelector('.thinking-wrap');
    const text = (card.textContent ?? '').trim();
    return !stillThinking && text.length > 5;
  }, { timeout: QUERY_TIMEOUT });
  await waitIdle(page);
}

type Snapshot = {
  hasCard: boolean;
  hasRouteStrip: boolean;
  hasIsoLegend: boolean;
  hasAlsoNearby: boolean;
  cardEyebrow: string;
  cardName: string;
  cardAddress: string;
  cardStats: string;
  cardPills: string[];
  steps: string[];
  toolPill: string;
  routeStrip: string;
  botText: string;
  fullText: string;
};

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const card = document.querySelector('.record-card');
    const txt = (sel: string) => (card?.querySelector(sel)?.textContent ?? '').trim();
    const txts = (sel: string) => Array.from(card?.querySelectorAll(sel) ?? []).map((el) => (el.textContent ?? '').trim()).filter(Boolean);
    const strip = document.querySelector('.route-strip');
    return {
      hasCard: !!card?.querySelector('.card-name'),
      hasRouteStrip: !!strip,
      hasIsoLegend: !!document.querySelector('.walk-legend'),
      hasAlsoNearby: !!card?.querySelector('.also-section'),
      cardEyebrow: txt('.card-eyebrow'),
      cardName: txt('.card-name'),
      cardAddress: txt('.card-address'),
      cardStats: txts('.stat').join(' | '),
      cardPills: txts('.pill'),
      steps: txts('.step-row'),
      toolPill: txt('.tool-pill'),
      routeStrip: (strip?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      botText: txt('.bot-text'),
      fullText: (card?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  });
}

test('demo-query battery', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await bootApp(page);

  const results: Array<{ id: string; q: string; ok: boolean; t_ms: number; snap: Snapshot; err?: string }> = [];

  for (const c of QUERIES) {
    const t0 = Date.now();
    process.stdout.write(`  ${c.id} ${c.q.slice(0, 60)}…\n    `);
    let ok = false; let snap: Snapshot; let err = '';
    try {
      await submitQuery(page, c.q);
      await waitForLatestRecord(page);
      snap = await snapshot(page);
      // Heuristic for "ok": has a card OR has bot text > 30 chars AND no error keywords
      const errorish = /unknown location|→ error|sorry -/i.test(snap.fullText);
      ok = !errorish && (snap.hasCard || snap.botText.length > 30);
    } catch (e) {
      err = (e as Error).message.slice(0, 200);
      snap = { hasCard: false, hasRouteStrip: false, hasIsoLegend: false, hasAlsoNearby: false, cardEyebrow: '', cardName: '', cardAddress: '', cardStats: '', cardPills: [], steps: [], toolPill: '', routeStrip: '', botText: '', fullText: `(timeout: ${err})` };
    }
    const t_ms = Date.now() - t0;
    results.push({ id: c.id, q: c.q, ok, t_ms, snap, err });
    console.log(ok ? `✓ ${(t_ms/1000).toFixed(1)}s. ${snap.cardName || snap.botText.slice(0, 80)}` : `✗ ${(t_ms/1000).toFixed(1)}s. ${snap.fullText.slice(0, 100)}`);
  }

  // ── Generate the markdown report ────────────────────────────────────
  const md: string[] = [
    '# Demo-query battery report',
    '',
    `Run: ${new Date().toISOString()}`,
    `Pass: ${results.filter((r) => r.ok).length} / ${results.length}`,
    '',
  ];
  for (const r of results) {
    md.push(`## ${r.id} ${r.ok ? '✓' : '✗'}  (${(r.t_ms / 1000).toFixed(1)}s)`);
    md.push('', '> ' + r.q.replace(/\n/g, ' '), '');
    if (r.err) md.push('**TIMEOUT/ERR:** ' + r.err, '');
    md.push('- card?            ' + r.snap.hasCard);
    md.push('- route-strip?     ' + r.snap.hasRouteStrip);
    md.push('- iso legend?      ' + r.snap.hasIsoLegend);
    md.push('- ALSO NEARBY?     ' + r.snap.hasAlsoNearby);
    if (r.snap.cardEyebrow) md.push('- card-eyebrow:    `' + r.snap.cardEyebrow + '`');
    if (r.snap.cardName)    md.push('- card-name:       `' + r.snap.cardName + '`');
    if (r.snap.cardAddress) md.push('- card-address:    `' + r.snap.cardAddress + '`');
    if (r.snap.cardStats)   md.push('- stats:           `' + r.snap.cardStats + '`');
    if (r.snap.cardPills.length) md.push('- pills:           ' + r.snap.cardPills.map((p) => '`' + p + '`').join(' '));
    if (r.snap.steps.length)     md.push('- steps:           ' + r.snap.steps.length + ' steps');
    if (r.snap.toolPill)         md.push('- tool-pill:       `' + r.snap.toolPill + '`');
    if (r.snap.routeStrip)       md.push('- route-strip:     `' + r.snap.routeStrip + '`');
    if (r.snap.botText)          md.push('- narration:       `' + r.snap.botText.slice(0, 240) + '`');
    md.push('');
  }
  const outPath = path.join('test-results', 'demo-queries-report.md');
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync(outPath, md.join('\n'));
  console.log(`\n→ Full report: ${outPath}`);

  await page.close();
  await ctx.close();
});
