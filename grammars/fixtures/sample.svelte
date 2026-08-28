<script lang="ts">
  export let name: string = "poly";
  let count = 0;
  $: doubled = count * 2;
</script>

<button on:click={() => (count += 1)}>
  {name}: {count} ({doubled})
</button>

{#if count > 3}
  <p class="warn">that's a lot</p>
{/if}

<style>
  .warn { color: crimson; }
</style>
