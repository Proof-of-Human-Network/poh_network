<script setup>
import HumanPower from './components/HumanPower.vue'
</script>

<template>
  <div class="layout">
    <HumanPower />
    
    <span class="footer-divider">·</span>

    <footer class="site-footer">
      <a href="https://t.me/poh_network_group" target="_blank" rel="noopener" class="footer-link">
        Telegram
      </a>
      <a href="https://x.com/poh_network" target="_blank" rel="noopener" class="footer-link">
        X / Twitter
      </a>
      <a href="https://drive.google.com/file/d/1hsO9V9VYTZ9pPcbgvYX6zJG_dSid1vfS/view?usp=sharing" target="_blank" rel="noopener" class="footer-link">
        Deck
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
  padding: 3.25rem 1.5rem;
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
