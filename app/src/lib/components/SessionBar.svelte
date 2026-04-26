<script lang="ts">
  import { queryLog } from '$lib/stores/query-log';
  import { online } from '$lib/stores/network';

  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => { now = new Date(); }, 30_000);
    return () => clearInterval(id);
  });

  const timeStr = $derived(
    now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  );
  const dateStr = $derived(
    now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      .replace(',', ' ·').toUpperCase()
  );
</script>

<header class="session-bar" aria-label="Session status">
  <div class="session-left">
    <span class="session-label">Session</span>
    <span class="session-time tnum">{timeStr} · {dateStr} · New York City</span>
    <span class="session-spacer" aria-hidden="true"></span>
    <span class="session-status net-pill" class:net-pill--offline={!$online} class:net-pill--online={$online}>
      <span class="net-dot" aria-hidden="true"></span>
      <span>{$online ? 'Network' : 'Offline'}</span>
    </span>
    <span class="session-status">● Local · {$queryLog.length} record{$queryLog.length !== 1 ? 's' : ''}</span>
  </div>

</header>

<style>
  .session-bar {
    flex-shrink: 0;
    height: 48px;
    background: var(--ink);
    color: var(--bg);
    display: flex;
    align-items: stretch;
    border-bottom: 0;
  }

  .session-left {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 20px;
    overflow: hidden;
  }

  .session-label {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    opacity: 0.5;
    flex-shrink: 0;
  }

  .session-time {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }

  .session-spacer { flex: 1; }

  .session-status {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    opacity: 0.6;
    flex-shrink: 0;
    white-space: nowrap;
  }

  /* Phone: hide non-essential text and shrink padding */
  @media (max-width: 640px) {
    .session-bar { height: 40px; }
    .session-left { gap: 8px; padding: 0 10px; }
    .session-label { display: none; }
    .session-time { font-size: 11px; letter-spacing: 0.02em; }
    .session-status { font-size: 9px; letter-spacing: 0.10em; }
  }
  /* Phone, very narrow (e.g. iPhone SE): drop the date string entirely */
  @media (max-width: 380px) {
    .session-time { display: none; }
  }

  /* Network-status pill. Mirrors the LOCAL indicator's typography. */
  .net-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    opacity: 0.85;
  }
  .net-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .net-pill--online {
    color: var(--muted, rgba(255,255,255,0.55));
    opacity: 0.55;
  }
  .net-pill--offline {
    color: var(--ok, #3fb950);
    opacity: 1;
  }
  .net-pill--offline .net-dot {
    animation: net-pulse 1.6s ease-in-out infinite;
  }
  @keyframes net-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.4; }
  }
  @media (prefers-reduced-motion: reduce) {
    .net-pill--offline .net-dot { animation: none; }
  }

</style>
