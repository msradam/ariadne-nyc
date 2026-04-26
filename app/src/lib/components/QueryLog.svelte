<script lang="ts">
  import { queryLog } from '$lib/stores/query-log';

  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => { now = new Date(); }, 30_000);
    return () => clearInterval(id);
  });

  const sessionTime = $derived(
    now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  );

  // Show newest at top
  const reversed = $derived([...$queryLog].reverse());

  function zeroPad(n: number) { return String(n).padStart(2, '0'); }
</script>

<div class="query-log" aria-label="Query log">
  <!-- Ink header -->
  <div class="log-header" aria-hidden="true">
    <span class="header-left">QUERY LOG · SESSION {sessionTime}</span>
    <span class="header-right">{$queryLog.length} RECORD{$queryLog.length !== 1 ? 'S' : ''}</span>
  </div>

  <!-- Entry list -->
  <ol class="entry-list" aria-label="Query history">
    {#each reversed as entry (entry.id)}
      <li
        class="entry-row"
        class:entry-active={entry.status === 'active'}
        class:entry-error={entry.status === 'error'}
        aria-current={entry.status === 'active' ? 'true' : undefined}
      >
        <span class="entry-num tnum" class:num-active={entry.status === 'active'}>{zeroPad(entry.num)}</span>
        <span class="entry-time tnum mono">{entry.time}</span>
        <span class="entry-text" class:text-active={entry.status === 'active'}>{entry.text}</span>
        <span class="entry-status" class:status-active={entry.status === 'active'}>
          {entry.status === 'active' ? 'ACTIVE' : entry.status === 'error' ? 'ERROR' : entry.status === 'pending' ? 'PEND' : 'DONE'}
        </span>
      </li>
    {/each}

    {#if $queryLog.length === 0}
      <li class="entry-empty">No queries yet</li>
    {/if}
  </ol>
</div>

<style>
  .query-log {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    overflow: hidden;
  }

  /* Ink header */
  .log-header {
    height: 38px;
    flex-shrink: 0;
    background: var(--ink);
    color: var(--bg);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 14px;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-family: var(--font-mono);
  }

  /* Entry list */
  .entry-list {
    list-style: none;
    padding: 0;
    margin: 0;
    overflow-y: auto;
    max-height: 180px;
  }

  .entry-row {
    display: grid;
    grid-template-columns: 44px 56px 1fr auto;
    align-items: center;
    gap: 0;
    padding: 6px 14px;
    border-bottom: 1px dashed var(--border-2);
    min-height: 32px;
  }

  .entry-row.entry-active {
    background: oklch(0.55 0.13 145 / 0.10);
    border-left: 3px solid var(--primary);
    padding-left: 11px;
  }

  .entry-row.entry-error {
    background: oklch(0.55 0.20 28 / 0.08);
    border-left: 3px solid var(--error);
    padding-left: 11px;
  }

  .entry-num {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 800;
    color: var(--muted);
  }

  .entry-num.num-active {
    color: var(--primary);
  }

  .entry-time {
    font-size: 11px;
    color: var(--muted);
    padding-right: 8px;
  }

  .entry-text {
    font-size: 12px;
    font-weight: 500;
    color: var(--ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-right: 8px;
  }

  .entry-text.text-active {
    font-weight: 700;
    color: var(--ink);
  }

  .entry-status {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--subtle);
    white-space: nowrap;
    font-family: var(--font-mono);
  }

  .entry-status.status-active {
    color: var(--primary);
  }

  .entry-empty {
    padding: 12px 14px;
    font-size: 11px;
    color: var(--subtle);
    font-style: italic;
  }
</style>
