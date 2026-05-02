<script setup>
import Landing from './components/Landing.vue'
</script>

<template>
  <Landing />

  <footer class="site-footer">
    <a href="https://t.me/poh_network_group" target="_blank" rel="noopener" class="footer-link">Telegram</a>
    <a href="https://x.com/poh_network" target="_blank" rel="noopener" class="footer-link">X / Twitter</a>
    <a href="https://proofofhuman.ge" target="_blank" rel="noopener" class="footer-link">Launch App →</a>
  </footer>
</template>

<style scoped>
.site-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 3rem 1.5rem;
  border-top: 1px solid #111;
  margin-top: auto;
}
.footer-link {
  color: #444;
  text-decoration: none;
  font-size: 0.8rem;
  transition: color 0.15s;
}
.footer-link:hover { color: #aaa; }
</style>
