<script setup>
import HumanPower from './components/HumanPower.vue'
</script>

<template>
  <div class="layout">
    <HumanPower />
    <footer class="site-footer">
      <a href="https://t.me/poh_network_group" target="_blank" rel="noopener" class="footer-link">
        <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L8.32 14.26l-2.96-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.828.299z"/></svg>
        Telegram
      </a>
      <span class="footer-divider">·</span>
      <a href="https://x.com/poh_network" target="_blank" rel="noopener" class="footer-link">
        <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
        X / Twitter
      </a>
    </footer>
  </div>
</template>

<style scoped>
.layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.site-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 1.25rem 1.5rem;
  border-top: 1px solid #111;
  margin-top: auto;
}

.footer-divider {
  color: #2a2a2a;
  font-size: 1rem;
}

.footer-link {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  color: #444;
  text-decoration: none;
  font-size: 0.8rem;
  transition: color 0.15s;
}

.footer-link:hover {
  color: #aaa;
}
</style>
