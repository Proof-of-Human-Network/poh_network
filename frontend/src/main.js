import { Buffer } from 'buffer'
window.Buffer = Buffer

import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import './assets/solana-wallet.css'

// Fix corrupted localStorage wallet keys (ensure JSON-quoted format)
try {
  ;['walletName', 'selectedWallet'].forEach(key => {
    const val = localStorage.getItem(key)
    if (val && !val.startsWith('"')) localStorage.removeItem(key)
  })
} catch {}

createApp(App).mount('#app')
