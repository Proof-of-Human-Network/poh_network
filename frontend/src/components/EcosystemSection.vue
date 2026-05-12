<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'
import { ExternalLink, Globe } from 'lucide-vue-next'

const projects  = ref([])
const loading   = ref(false)
const view      = ref('list') // 'list' | 'apply'

// Form fields
const form = ref({ name: '', website: '', logo: '', description: '', integration: '', contact: '' })
const submitting = ref(false)
const submitMsg  = ref(null) // { ok, text }

async function loadProjects() {
  loading.value = true
  try {
    const res = await axios.get('/ecosystem')
    projects.value = res.data
  } catch {
    projects.value = []
  } finally {
    loading.value = false
  }
}

async function submitApplication() {
  submitMsg.value = null
  const f = form.value
  if (!f.name || !f.website || !f.description || !f.integration || !f.contact) {
    submitMsg.value = { ok: false, text: 'Please fill in all required fields.' }
    return
  }
  submitting.value = true
  try {
    await axios.post('/ecosystem/apply', f)
    submitMsg.value = { ok: true, text: 'Application submitted! We will review it and get back to you.' }
    form.value = { name: '', website: '', logo: '', description: '', integration: '', contact: '' }
  } catch (err) {
    submitMsg.value = { ok: false, text: err.response?.data?.error || 'Submission failed, try again.' }
  } finally {
    submitting.value = false
  }
}

function logoFallback(p) {
  return p.name?.charAt(0)?.toUpperCase() || '?'
}

onMounted(loadProjects)
</script>

<template>
  <div class="eco-page">
    <div class="scan-hero">
      <div class="scan-tag">ECOSYSTEM</div>
      <h2 class="scan-title">Integrated Projects</h2>
      <p class="scan-sub">Projects and protocols that use POH's humanity verification API. Each integration is manually reviewed and approved.</p>
    </div>

    <!-- Tab toggle -->
    <div class="eco-tabs">
      <button :class="['eco-tab', { active: view === 'list' }]" @click="view = 'list'">Partners</button>
      <button :class="['eco-tab', { active: view === 'apply' }]" @click="view = 'apply'">Apply for Integration</button>
    </div>

    <!-- ── Partner list ─────────────────────────────────────────────────────── -->
    <div v-if="view === 'list'">
      <div v-if="loading" class="empty-state"><p>Loading...</p></div>

      <div v-else-if="projects.length === 0" class="eco-empty">
        <Globe :size="40" class="eco-empty-icon" />
        <p class="eco-empty-text">No integrations listed yet.</p>
        <button class="submit-listing-btn" @click="view = 'apply'">Be the first →</button>
      </div>

      <div v-else class="eco-grid">
        <div v-for="p in projects" :key="p.id" class="eco-card glass-panel">
          <div class="eco-card-logo">
            <img v-if="p.logo" :src="p.logo" :alt="p.name" class="eco-logo-img" @error="e => e.target.style.display='none'" />
            <span v-else class="eco-logo-fallback">{{ logoFallback(p) }}</span>
          </div>
          <div class="eco-card-body">
            <div class="eco-card-name">{{ p.name }}</div>
            <p class="eco-card-desc">{{ p.description }}</p>
            <div class="eco-integration-label">Integration</div>
            <p class="eco-card-integration">{{ p.integration }}</p>
            <a v-if="p.website" :href="p.website" target="_blank" rel="noopener" class="eco-link">
              Visit <ExternalLink :size="12" />
            </a>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Application form ─────────────────────────────────────────────────── -->
    <div v-if="view === 'apply'" class="eco-form-wrap glass-panel">
      <h3 class="eco-form-title">Apply for Ecosystem Listing</h3>
      <p class="eco-form-sub">Tell us about your project and how you're integrating POH. We review every application manually before approving.</p>

      <div class="eco-fields">
        <div class="eco-field">
          <label class="eco-label">Project name <span class="eco-required">*</span></label>
          <input v-model="form.name" class="premium-input" placeholder="e.g. MyProtocol" />
        </div>

        <div class="eco-field">
          <label class="eco-label">Website <span class="eco-required">*</span></label>
          <input v-model="form.website" class="premium-input" placeholder="https://myprotocol.xyz" />
        </div>

        <div class="eco-field">
          <label class="eco-label">Logo URL <span class="eco-optional">(optional)</span></label>
          <input v-model="form.logo" class="premium-input" placeholder="https://myprotocol.xyz/logo.png" />
        </div>

        <div class="eco-field">
          <label class="eco-label">What does your project do? <span class="eco-required">*</span></label>
          <textarea v-model="form.description" class="premium-input eco-textarea" placeholder="Brief description of your project..." rows="3"></textarea>
        </div>

        <div class="eco-field">
          <label class="eco-label">What is the POH integration for? <span class="eco-required">*</span></label>
          <textarea v-model="form.integration" class="premium-input eco-textarea" placeholder="e.g. We use POH to gate access to our airdrop, ensuring only verified humans can claim..." rows="3"></textarea>
        </div>

        <div class="eco-field">
          <label class="eco-label">Contact email <span class="eco-required">*</span></label>
          <input v-model="form.contact" class="premium-input" placeholder="team@myprotocol.xyz" type="email" />
        </div>
      </div>

      <div v-if="submitMsg" :class="['eco-submit-msg', submitMsg.ok ? 'eco-submit-msg--ok' : 'eco-submit-msg--err']">
        {{ submitMsg.text }}
      </div>

      <button class="submit-listing-btn" :disabled="submitting" @click="submitApplication">
        {{ submitting ? 'Submitting...' : 'Submit Application' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.eco-page { max-width: 960px; margin: 0 auto; padding: 2rem 1rem 4rem; }

.eco-tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 2.5rem;
  border-bottom: 1px solid #1a1a1a;
  padding-bottom: 0;
}
.eco-tab {
  background: none;
  border: none;
  color: #666;
  font-size: 0.85rem;
  font-weight: 500;
  padding: 0.6rem 1.1rem;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
}
.eco-tab.active { color: #fff; border-bottom-color: #fff; }
.eco-tab:hover:not(.active) { color: #aaa; }

/* Empty state */
.eco-empty { text-align: center; padding: 4rem 1rem; }
.eco-empty-icon { color: #333; margin-bottom: 1rem; }
.eco-empty-text { color: #555; margin-bottom: 1.5rem; }

/* Grid */
.eco-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1.25rem;
}
.eco-card {
  padding: 1.5rem;
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}
.eco-card-logo {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
  background: #111;
  display: flex;
  align-items: center;
  justify-content: center;
}
.eco-logo-img { width: 100%; height: 100%; object-fit: cover; }
.eco-logo-fallback { font-size: 1.3rem; font-weight: 700; color: #888; }
.eco-card-body { flex: 1; min-width: 0; }
.eco-card-name { font-size: 1rem; font-weight: 600; color: #eee; margin-bottom: 0.4rem; }
.eco-card-desc { font-size: 0.82rem; color: #777; margin: 0 0 0.75rem; line-height: 1.5; }
.eco-integration-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #444; margin-bottom: 0.25rem; }
.eco-card-integration { font-size: 0.82rem; color: #999; margin: 0 0 0.75rem; line-height: 1.5; }
.eco-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.78rem;
  color: #888;
  text-decoration: none;
  transition: color 0.15s;
}
.eco-link:hover { color: #fff; }

/* Form */
.eco-form-wrap { padding: 2rem; max-width: 640px; }
.eco-form-title { font-size: 1.15rem; font-weight: 600; color: #eee; margin: 0 0 0.5rem; }
.eco-form-sub { font-size: 0.84rem; color: #666; margin: 0 0 1.75rem; line-height: 1.6; }
.eco-fields { display: flex; flex-direction: column; gap: 1.1rem; margin-bottom: 1.5rem; }
.eco-field { display: flex; flex-direction: column; gap: 0.35rem; }
.eco-label { font-size: 0.82rem; color: #888; }
.eco-required { color: #e05; }
.eco-optional { color: #555; font-size: 0.75rem; }
.eco-textarea { resize: vertical; min-height: 80px; font-family: inherit; line-height: 1.5; }

.eco-submit-msg {
  font-size: 0.84rem;
  padding: 0.65rem 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
}
.eco-submit-msg--ok  { background: #0a1f0a; color: #4caf50; border: 1px solid #1a3a1a; }
.eco-submit-msg--err { background: #1f0a0a; color: #e05; border: 1px solid #3a1a1a; }
</style>
