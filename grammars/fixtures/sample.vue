<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ title: string; releases: Array<{ tag: string; assets: number }> }>();
const emit = defineEmits<{ (e: "select", tag: string): void }>();

const filter = ref("");
const visible = computed(() =>
  props.releases.filter((r) => r.tag.includes(filter.value)),
);
</script>

<template>
  <section class="panel">
    <h1>{{ props.title }}</h1>
    <input v-model="filter" placeholder="filter tags" />

    <ul v-if="visible.length">
      <li v-for="release in visible" :key="release.tag" @click="emit('select', release.tag)">
        <strong>{{ release.tag }}</strong>
        <span>{{ release.assets }} assets</span>
      </li>
    </ul>
    <p v-else>Nothing matches “{{ filter }}”.</p>
  </section>
</template>

<style scoped>
.panel {
  --gap: 0.5rem;
  display: grid;
  gap: var(--gap);
}
.panel li {
  cursor: pointer;
}
</style>
