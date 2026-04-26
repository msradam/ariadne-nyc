<script lang="ts">
  let { target = '#content' }: { target?: string } = $props();
</script>

<!--
  Skip link. First focusable element in the page.
  Visually hidden until focused; jumps keyboard users past repeated navigation.
  WCAG 2.4.1 Bypass Blocks (Level A).
-->
<a
  href={target}
  class="skip-link"
>
  Skip to main content
</a>

<style>
  .skip-link {
    position: absolute;
    top: -9999px;
    left: 6px;
    z-index: 9999;
    padding: 8px 16px;
    background: var(--accent);
    color: var(--bg);
    font-weight: 600;
    font-size: 0.875rem;
    border-radius: 0 0 6px 6px;
    text-decoration: none;
    white-space: nowrap;
  }

  .skip-link:focus-visible {
    top: 0;
    outline: 2px solid var(--bg);
    outline-offset: -4px;
  }
</style>
