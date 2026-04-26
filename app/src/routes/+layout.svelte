<script lang="ts">
  import '../app.css';
  import SkipLink from '$lib/components/SkipLink.svelte';
  import WayfindingStrip from '$lib/components/WayfindingStrip.svelte';
  import SessionBar from '$lib/components/SessionBar.svelte';

  let { children } = $props();
</script>

<SkipLink />
<div class="app">
  <WayfindingStrip />
  <div class="main-col">
    <SessionBar />
    <main id="content" tabindex="-1">
      {@render children()}
    </main>
  </div>
</div>

<style>
  .app {
    height: 100dvh;
    display: flex;
    overflow: hidden;
  }

  .main-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    outline: none;
  }

  /* Phone: hide the vertical brand strip. It's 56px we can't spare. */
  @media (max-width: 640px) {
    .app :global(.strip) { display: none; }
  }
</style>
