<script lang="ts">
  import { onMount } from 'svelte';
  import { loadMessage, loadProgress, loadPhase } from '../stores/feeds';

  type BoroughEntry = { id: string; name: string; d: string };
  type LoadRow = { id: string; state: 'spin' | 'ok' | 'err' | 'wait'; label: string };
  let { rows }: { rows: LoadRow[] } = $props();

  const REVEAL_ORDER = ['bx', 'mn', 'qn', 'rk', 'bk', 'si'];
  let boroughData = $state<BoroughEntry[]>([]);

  onMount(async () => {
    try {
      const r = await fetch('/nyc-boroughs.json');
      const raw: BoroughEntry[] = await r.json();
      // sort by reveal order
      boroughData = REVEAL_ORDER
        .map(id => raw.find(b => b.id === id))
        .filter((b): b is BoroughEntry => !!b);
    } catch { /* silently fail. Loading screen still works */ }
  });

  const fillFraction = $derived($loadProgress / 100);
  const currentBorough = $derived(
    REVEAL_ORDER[Math.min(5, Math.floor(fillFraction * 6))]
  );
  const dashOffset = $derived(2400 - fillFraction * 2400);
  const mbLoaded = $derived((fillFraction * 30).toFixed(1));
</script>

<div class="screen" role="status" aria-live="polite" aria-label="Application loading">
  <!-- Dot grid texture -->
  <div class="dot-grid" aria-hidden="true"></div>

  <!-- Borough silhouette -->
  <div class="silhouette" aria-hidden="true">
    <!-- Base outline -->
    <svg viewBox="0 0 2281.199 2337.062" width="220" height="226" class="sil-base">
      <g transform="translate(-626.23 -83.751) scale(0.99975)">
        {#each boroughData as b}
          <path d={b.d} fill="var(--border)" stroke="none" />
        {/each}
      </g>
    </svg>
    <!-- Animated fill -->
    <svg viewBox="0 0 2281.199 2337.062" width="220" height="226" class="sil-fill">
      <g transform="translate(-626.23 -83.751) scale(0.99975)">
        {#each boroughData as b, i}
          <path
            d={b.d}
            fill="var(--primary)"
            stroke="var(--ink)"
            stroke-width="3"
            stroke-linejoin="round"
            style="opacity: {i < fillFraction * 6 ? 1 : 0.12}; transition: opacity 400ms ease"
          />
        {/each}
        <!-- Ariadne thread -->
        <path
          d="M 1400 400 Q 1350 700 1320 1000 T 1280 1400 Q 1250 1700 1300 2000 Q 1350 2100 1400 2050"
          stroke="var(--accent)"
          stroke-width="8"
          fill="none"
          stroke-linecap="round"
          stroke-dasharray="2400"
          stroke-dashoffset={dashOffset}
          style="transition: stroke-dashoffset 0.2s linear"
        />
        <circle cx="1400" cy="400" r="16" fill="var(--accent)" />
        {#if fillFraction > 0.95}
          <circle cx="1400" cy="2050" r="16" fill="var(--accent)" />
        {/if}
      </g>
    </svg>
  </div>

  <!-- Status text -->
  <div class="status-text">
    <div class="eyebrow">Building your route map</div>
    <div class="headline">Loading the five-borough walking graph</div>
    <div class="body-text">
      One-time download. Everything runs in your browser after this. No servers, no tracking.
    </div>
  </div>

  <!-- Progress bar -->
  <div class="progress-wrap">
    <div
      class="bar-track"
      role="progressbar"
      aria-valuenow={$loadProgress}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Loading progress"
    >
      <div class="bar-fill" style="width:{$loadProgress}%"></div>
    </div>
    <div class="bar-meta tnum mono">
      <span>{mbLoaded} / 30 MB</span>
      <span>{currentBorough} ✓</span>
    </div>
  </div>

  <!-- Stage rows -->
  <ul class="stage-rows" aria-label="Loading steps">
    {#each rows as row (row.id)}
      <li class="stage-row">
        <span class="stage-dot dot-{row.state}" aria-hidden="true"></span>
        <span class="stage-label">{row.label}</span>
        <span class="stage-state">
          {#if row.state === 'ok'}✓
          {:else if row.state === 'err'}✗
          {:else if row.state === 'spin'}…
          {:else}-{/if}
        </span>
      </li>
    {/each}
  </ul>

  <!-- Tip -->
  <div class="tip" aria-live="off">
    <span class="tip-lead">Did you know · </span>
    Ariadne uses crowdsourced curb-cut and elevator data from
    <strong>OpenSidewalks</strong> alongside official NYC accessibility surveys.
  </div>
</div>

<style>
  .screen {
    position: fixed;
    inset: 0;
    background: var(--bg);
    color: var(--ink);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 20px;
    padding: 40px;
    z-index: 9999;
    overflow: hidden;
  }

  .dot-grid {
    position: absolute;
    inset: 0;
    background-image: radial-gradient(oklch(0.55 0.05 65 / 0.06) 1px, transparent 1px);
    background-size: 24px 24px;
    pointer-events: none;
  }

  .silhouette {
    position: relative;
    width: 220px;
    aspect-ratio: 2281 / 2337;
    flex-shrink: 0;
  }

  .sil-base {
    position: absolute;
    inset: 0;
    width: 100%;
    height: auto;
    opacity: 0.5;
  }

  .sil-fill {
    position: absolute;
    inset: 0;
    width: 100%;
    height: auto;
  }

  .status-text {
    text-align: center;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .eyebrow {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .headline {
    font-size: 18px;
    font-weight: 700;
    line-height: 1.35;
    color: var(--ink);
  }

  .body-text {
    font-size: 13px;
    color: var(--muted);
    line-height: 1.45;
  }

  .progress-wrap {
    width: 320px;
    flex-shrink: 0;
  }

  .bar-track {
    height: 6px;
    background: var(--border);
    border-radius: 999px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    background: var(--primary);
    border-radius: 999px;
    transition: width 0.2s ease;
  }

  .bar-meta {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
  }

  .stage-rows {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 320px;
    flex-shrink: 0;
  }

  .stage-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--ink-2);
  }

  .stage-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .dot-spin { background: var(--primary); animation: pulse 1s infinite; }
  .dot-ok   { background: var(--ok); }
  .dot-err  { background: var(--error); }
  .dot-wait { background: var(--border-2); }

  .stage-label { flex: 1; }
  .stage-state { font-weight: 700; color: var(--muted); font-family: var(--font-mono); font-size: 11px; }

  .tip {
    max-width: 360px;
    padding: 10px 16px;
    background: var(--surface);
    border: 2px solid var(--border);
    border-radius: 2px;
    font-size: 12px;
    color: var(--ink-2);
    line-height: 1.5;
    text-align: center;
  }

  .tip-lead {
    font-weight: 700;
    color: var(--primary);
  }

  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }
</style>
