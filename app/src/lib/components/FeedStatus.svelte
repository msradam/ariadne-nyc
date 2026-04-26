<script lang="ts">
  import { transitState } from '../stores/feeds';
</script>

{#if $transitState?.loaded}
  <div class="feed-line" role="status" aria-live="polite">
    <span class="meta-text">{$transitState.stopsCount} stops · {$transitState.adaCount} ADA</span>
    {#if $transitState.elevatorsOut > 0}
      <span class="warn-note">{$transitState.elevatorsOut} elevators out</span>
    {/if}
  </div>
{/if}

<style>
  .feed-line {
    padding: 8px 20px;
    background: var(--ink);
    color: var(--surface);
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.10em;
    font-family: var(--font-mono);
    opacity: 0.85;
  }

  .meta-text { opacity: 0.7; }
  .warn-note { color: var(--warn); }
</style>
