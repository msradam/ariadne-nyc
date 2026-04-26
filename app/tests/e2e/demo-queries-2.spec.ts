/**
 * Second demo-candidate battery (queries 11-15). Same harness as
 * demo-queries.spec.ts. Captures full output to test-results/.
 */
import { test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const QUERIES = [
  { id: '11', q: "I'm at Grand Army Plaza in Brooklyn. Find me indoor warming centers with seating I can walk to." },
  { id: '12', q: 'From Atlantic Terminal, walking route to the closest pharmacy, low-vision profile.' },
  { id: '13', q: "I'm at the High Line. Wheelchair-accessible route to the nearest public restroom with seating." },
  { id: '14', q: "I'm at Yankee Stadium. Cooling centers within walking distance." },
  { id: '15', q: "I'm at Washington Square Park. Find libraries within 15 minutes walking distance." },
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

async function snapshot(page: Page) {
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

test('demo-query battery 2 (11-15)', async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await bootApp(page);

  const results: Array<{ id: string; q: string; ok: boolean; t_ms: number; snap: any; err?: string }> = [];

  for (const c of QUERIES) {
    const t0 = Date.now();
    process.stdout.write(`  ${c.id} ${c.q.slice(0, 60)}…\n    `);
    let ok = false; let snap: any; let err = '';
    try {
      await submitQuery(page, c.q);
      await waitForLatestRecord(page);
      snap = await snapshot(page);
      const errorish = /unknown location|→ error|sorry -|<tool_call>/i.test(snap.fullText);
      ok = !errorish && (snap.hasCard || snap.botText.length > 30);
    } catch (e) {
      err = (e as Error).message.slice(0, 200);
      snap = { hasCard: false, hasRouteStrip: false, hasIsoLegend: false, hasAlsoNearby: false, cardEyebrow: '', cardName: '', cardAddress: '', cardStats: '', cardPills: [], steps: [], toolPill: '', routeStrip: '', botText: '', fullText: `(timeout: ${err})` };
    }
    const t_ms = Date.now() - t0;
    results.push({ id: c.id, q: c.q, ok, t_ms, snap, err });
    console.log(ok ? `✓ ${(t_ms/1000).toFixed(1)}s. ${snap.cardName || snap.botText.slice(0, 80)}` : `✗ ${(t_ms/1000).toFixed(1)}s. ${snap.fullText.slice(0, 100)}`);
  }

  const md: string[] = [
    '# Demo-query battery 2 (11-15)',
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
    if (r.snap.cardPills.length) md.push('- pills:           ' + r.snap.cardPills.map((p: string) => '`' + p + '`').join(' '));
    if (r.snap.steps.length)     md.push('- steps:           ' + r.snap.steps.length + ' steps');
    if (r.snap.toolPill)         md.push('- tool-pill:       `' + r.snap.toolPill + '`');
    if (r.snap.routeStrip)       md.push('- route-strip:     `' + r.snap.routeStrip + '`');
    if (r.snap.botText)          md.push('- narration:       `' + r.snap.botText.slice(0, 240) + '`');
    md.push('');
  }
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync(path.join('test-results', 'demo-queries-2-report.md'), md.join('\n'));
  console.log(`\n→ test-results/demo-queries-2-report.md`);

  await page.close();
  await ctx.close();
});
