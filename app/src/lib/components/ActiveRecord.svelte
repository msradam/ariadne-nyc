<script lang="ts">
  import type { QueryEntry } from '$lib/stores/query-log';
  import ExampleQueries from './ExampleQueries.svelte';

  let { entry }: { entry: QueryEntry | null } = $props();

  const ROMAN = ['i','ii','iii','iv','v','vi','vii','viii','ix','x','xi','xii','xiii','xiv','xv','xvi','xvii','xviii','xix','xx'];
  function toRoman(n: number): string { return ROMAN[n - 1] ?? String(n); }
  function zeroPad(n: number) { return String(n).padStart(2, '0'); }
</script>

<div class="active-record">
  {#if entry === null}
    <!-- Empty state -->
    <div class="empty-state">
      <p class="empty-doc-text">
        Ariadne is a working reference for accessible movement through New York.
        Type a query above to consult the record.
      </p>
      <ExampleQueries />
    </div>
  {:else}
    <!-- Active record -->
    <div class="record-eyebrow">ACTIVE RECORD · {zeroPad(entry.num)}</div>

    <div class="record-card">
      {#if entry.record.streaming && !entry.record.botText && !entry.record.card}
        <!-- Thinking dots -->
        <div class="thinking-wrap">
          <span class="thinking-dot"></span>
          <span class="thinking-dot"></span>
          <span class="thinking-dot"></span>
        </div>
      {/if}

      {#if entry.record.card}
        {@const card = entry.record.card}
        {@const eyebrow = card.kind === 'route'
          ? `CLOSEST MATCH · ${card.hasTransit ? 'WALK + SUBWAY' : 'STEP-FREE'}`
          : `CLOSEST MATCH · ${(card.destTypes[0] ?? 'PLACE').replace(/_/g, ' ').toUpperCase()}`}
        <!-- Card header -->
        <div class="card-header">
          <div class="card-eyebrow">{eyebrow}</div>
          <div class="card-name">{card.destName}</div>
          {#if card.destAddress}
            <div class="card-address">{card.destAddress}</div>
          {/if}
        </div>

        <!-- Stats grid -->
        <div class="stats-grid">
          <div class="stat">
            <div class="stat-label">Walk</div>
            <div class="stat-val tnum">{card.totalMin}</div>
            <div class="stat-unit">min</div>
          </div>
          {#if card.kind === 'route'}
            <div class="stat">
              <div class="stat-label">Distance</div>
              <div class="stat-val tnum">{(card.distM / 1609).toFixed(1)}</div>
              <div class="stat-unit">mi</div>
            </div>
          {:else}
            <div class="stat">
              <div class="stat-label">Found</div>
              <div class="stat-val tnum">{card.count}</div>
              <div class="stat-unit">{card.count === 1 ? 'site' : 'sites'}</div>
            </div>
          {/if}
          <div class="stat">
            <div class="stat-label">Profile</div>
            <div class="stat-val stat-val--sm">{card.profile.replace(/_/g, ' ')}</div>
            <div class="stat-unit">&nbsp;</div>
          </div>
        </div>

        <!-- Type pills -->
        {#if card.destTypes.length > 0}
          <div class="pills">
            {#each card.destTypes as t}
              <span class="pill">{t.replace(/_/g, ' ')}</span>
            {/each}
          </div>
        {/if}

        <!-- Also nearby (reachable only) -->
        {#if card.kind === 'reachable' && card.alsoNearby.length > 0}
          <div class="also-section">
            <div class="also-eyebrow">ALSO NEARBY</div>
            <ol class="also-list">
              {#each card.alsoNearby as n, i}
                <li class="also-row">
                  <span class="also-letter">{String.fromCharCode(66 + i)}</span>
                  <span class="also-body">
                    <span class="also-name">{n.name}</span>
                    {#if n.address}<span class="also-addr">{n.address}</span>{/if}
                  </span>
                  <span class="also-min tnum">{n.walkMin}<span class="also-min-unit"> min</span></span>
                </li>
              {/each}
            </ol>
          </div>
        {/if}
      {/if}

      <!-- Steps -->
      {#if entry.record.steps.length > 0}
        <div class="steps-section">
          <div class="steps-header roman">I. WALK</div>
          <ol class="step-list">
            {#each entry.record.steps as step, i}
              <li class="step-row">
                <span class="roman step-num">{toRoman(i + 1)}.</span>
                <span class="step-cue">{step.instruction}</span>
                {#if step.distance_m > 0}
                  <span class="step-dist tnum">{step.distance_m}m</span>
                {/if}
              </li>
            {/each}
          </ol>
        </div>
      {/if}

      <!-- Tool summary -->
      {#if entry.record.toolSummary}
        <div class="tool-pill">
          <span class="tool-dot">●</span> {entry.record.toolSummary}
        </div>
      {/if}

      <!-- Bot text (shown when no card) -->
      {#if entry.record.botText && !entry.record.card}
        <div class="bot-text">{entry.record.botText}</div>
      {/if}
    </div>

    <!-- Always show example queries below record -->
    <ExampleQueries />
  {/if}
</div>

<style>
  .active-record {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    background: var(--bg);
  }

  /* Empty state */
  .empty-state {
    padding: 20px;
  }

  .empty-doc-text {
    font-size: 13px;
    line-height: 1.6;
    color: var(--ink-2);
    margin-bottom: 20px;
    max-width: 340px;
  }

  /* Record eyebrow */
  .record-eyebrow {
    padding: 8px 14px 6px;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    color: var(--muted);
    font-family: var(--font-mono);
  }

  /* Record card */
  .record-card {
    margin: 0 14px 12px;
    border: 2px solid var(--ink);
    background: var(--surface);
  }

  /* Card header */
  .card-header {
    padding: 12px 16px;
    border-bottom: 2px solid var(--ink);
  }

  .card-eyebrow {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    font-family: var(--font-mono);
    margin-bottom: 4px;
  }

  .card-name {
    font-size: 18px;
    font-weight: 800;
    font-variant: small-caps;
    letter-spacing: 0.02em;
    color: var(--ink);
    line-height: 1.2;
  }

  .card-address {
    font-size: 12px;
    color: var(--muted);
    margin-top: 2px;
  }

  /* Stats grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-bottom: 1px solid var(--border);
  }

  .stat {
    padding: 12px 16px;
    border-right: 1px solid var(--border);
  }

  .stat:last-child {
    border-right: none;
  }

  .stat-label {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    font-family: var(--font-mono);
    margin-bottom: 2px;
  }

  .stat-val {
    font-size: 28px;
    font-weight: 800;
    color: var(--ink);
    line-height: 1;
    letter-spacing: -0.02em;
  }

  .stat-val--sm {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.4;
    margin-top: 4px;
    text-transform: capitalize;
  }

  .stat-unit {
    font-size: 10px;
    color: var(--muted);
    margin-top: 1px;
  }

  /* Pills */
  .pills {
    padding: 8px 16px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    border-bottom: 1px solid var(--border);
  }

  .pill {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 3px 8px;
    border: 1.5px solid var(--border-2);
    background: var(--bg);
    color: var(--ink-2);
    font-family: var(--font-mono);
  }

  /* Also nearby */
  .also-section {
    border-top: 1px solid var(--border);
    padding: 10px 16px 12px;
  }

  .also-eyebrow {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    font-family: var(--font-mono);
    margin-bottom: 8px;
  }

  .also-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
  }

  .also-row {
    display: grid;
    grid-template-columns: 22px 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px dashed var(--border);
  }

  .also-row:last-child { border-bottom: none; }

  .also-letter {
    width: 22px;
    height: 22px;
    background: var(--ink);
    color: var(--bg);
    font-size: 10px;
    font-weight: 800;
    font-family: var(--font-mono);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
  }

  .also-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .also-name {
    font-size: 12px;
    font-weight: 700;
    color: var(--ink);
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .also-addr {
    font-size: 10px;
    color: var(--muted);
    font-family: var(--font-mono);
    margin-top: 1px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .also-min {
    font-size: 14px;
    font-weight: 800;
    color: var(--ink);
    font-family: var(--font-mono);
    white-space: nowrap;
  }

  .also-min-unit {
    font-size: 9px;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: 0.06em;
  }

  /* Steps */
  .steps-section {
    padding: 10px 16px;
    border-top: 1px solid var(--border);
  }

  .steps-header {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
    font-family: var(--font-mono);
  }

  .step-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .step-row {
    display: grid;
    grid-template-columns: 24px 1fr auto;
    gap: 6px;
    align-items: baseline;
    font-size: 12px;
    padding: 2px 0;
    border-bottom: 1px dashed var(--border);
  }

  .step-row:last-child {
    border-bottom: none;
  }

  .step-num {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    color: var(--muted);
    text-transform: lowercase;
  }

  .step-cue {
    color: var(--ink-2);
    font-size: 12px;
    line-height: 1.4;
  }

  .step-dist {
    font-size: 10px;
    color: var(--muted);
    font-family: var(--font-mono);
    text-align: right;
    white-space: nowrap;
  }

  /* Tool pill */
  .tool-pill {
    margin: 8px 16px;
    padding: 6px 10px;
    border: 1px dashed var(--rule);
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--muted);
    background: var(--bg-2);
  }

  .tool-dot {
    color: var(--primary);
  }

  /* Bot text */
  .bot-text {
    padding: 12px 16px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--ink-2);
  }

  /* Thinking animation */
  .thinking-wrap {
    padding: 16px;
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .thinking-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--muted);
    animation: thinking 1.2s ease-in-out infinite;
  }

  .thinking-dot:nth-child(2) { animation-delay: 0.2s; }
  .thinking-dot:nth-child(3) { animation-delay: 0.4s; }

  @keyframes thinking {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .thinking-dot { animation: none; opacity: 0.7; }
  }
</style>
