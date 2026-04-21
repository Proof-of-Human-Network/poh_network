import { Buffer } from 'buffer'
window.Buffer = Buffer

import { createApp } from 'vue'
import App from './App.vue'
import { initWallet } from '@solana/wallet-adapter-vue'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare'
import './assets/solana-wallet.css'

// Robust fix for corrupted localStorage
try {
  const keys = ['walletName', 'selectedWallet']
  keys.forEach(key => {
    const val = localStorage.getItem(key)
    if (val && !val.startsWith('"')) {
      localStorage.removeItem(key)
    }
  })
} catch (e) {}

initWallet({
  wallets: [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter()
  ],
  autoConnect: true
})

createApp(App).mount('#app')
