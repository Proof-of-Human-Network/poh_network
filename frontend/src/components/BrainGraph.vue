<template>
  <div class="bg-wrap" ref="wrapRef">
    <canvas ref="canvasRef" class="bg-canvas" @mousemove="onMouseMove" @mouseleave="tooltip = null" />
    <div v-if="tooltip" class="bg-tooltip" :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }">
      {{ tooltip.text }}
    </div>
    <div class="bg-stats">
      <span class="bg-stat"><span class="bg-dot bg-dot--evm" />{{ counts.evm }} EVM</span>
      <span class="bg-stat"><span class="bg-dot bg-dot--rest" />{{ counts.rest }} REST</span>
      <span class="bg-stat"><span class="bg-dot bg-dot--solana" />{{ counts.solana }} Solana</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import * as d3 from 'd3'

const props = defineProps({ methods: { type: Array, default: () => [] } })

const wrapRef  = ref(null)
const canvasRef = ref(null)
const tooltip   = ref(null)

const TYPE_COLOR = { evm: '#627EEA', rest: '#00D395', solana: '#9945FF' }
const BRAIN_COLOR = '#e8e8ff'
const HUMAN_COLOR = '#22c55e'
const BOT_COLOR   = '#ef4444'

const counts = computed(() => ({
  evm:    props.methods.filter(m => m.type === 'evm').length,
  rest:   props.methods.filter(m => m.type === 'rest').length,
  solana: props.methods.filter(m => m.type === 'solana').length,
}))

// ── Graph state ───────────────────────────────────────────────────────────────
let sim = null
let nodes = []
let links = []
let particles = []   // { x, y, tx, ty, t, color }
let brainPulse = 0   // 0..1 decay
let activeNodeId = null
let pulseTimer = null
let rafId = null
let W = 0, H = 0

function shortLabel(desc = '') {
  return desc.split(' — ')[0].split(' – ')[0].split(' (')[0].trim().slice(0, 18)
}

function nodeRadius(m) {
  const s = Math.abs(m.score || 0)
  return 4.5 + Math.min(4, s * 0.4)
}

function layoutScale() {
  return Math.min(1.3, Math.min(W, H + 60) / 520)
}

function buildGraph() {
  const s = layoutScale()
  const brainNode = { id: '__brain__', kind: 'brain',  label: 'AI BRAIN', r: 32, fx: 0, fy: Math.round(-20 * s) }
  const humanNode = { id: '__human__', kind: 'verdict', label: 'HUMAN',    r: 22, fx: Math.round(-150 * s), fy: Math.round(190 * s) }
  const botNode   = { id: '__bot__',   kind: 'verdict', label: 'BOT / AI', r: 22, fx:  Math.round(150 * s), fy: Math.round(190 * s) }

  const mNodes = props.methods.map(m => ({
    id: m.id, kind: 'method', type: m.type,
    label: shortLabel(m.description),
    r: nodeRadius(m),
    score: m.score || 0,
  }))

  nodes = [
    brainNode,
    humanNode,
    botNode,
    ...mNodes
  ]

  links = [
    ...mNodes.map(n => ({ source: n.id, target: '__brain__', mtype: n.type })),
    { source: '__brain__', target: '__human__', mtype: 'verdict' },
    { source: '__brain__', target: '__bot__',   mtype: 'verdict' },
  ]
}

function initSim() {
  if (sim) sim.stop()
  const s = layoutScale()

  sim = d3.forceSimulation(nodes)
    .force('link',    d3.forceLink(links).id(d => d.id).distance(d => d.mtype === 'verdict' ? Math.round(180 * s) : Math.round(110 * s)).strength(0.25))
    .force('charge',  d3.forceManyBody().strength(-22))
    .force('collide', d3.forceCollide(d => d.r + 5))
    .force('radial',  d3.forceRadial(d => {
      if (d.kind === 'brain' || d.kind === 'verdict') return 0
      return Math.round(145 * s)
    }, 0, Math.round(-20 * s)).strength(0.55))
    .alphaDecay(0.015)
    .velocityDecay(0.4)
    .on('tick', renderFrame)
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderFrame() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, W, H)

  ctx.save()
  ctx.translate(W / 2, H / 2)

  // ── Edges ──────────────────────────────────────────────────────────────────
  links.forEach(l => {
    const s = typeof l.source === 'object' ? l.source : nodes.find(n => n.id === l.source)
    const t = typeof l.target === 'object' ? l.target : nodes.find(n => n.id === l.target)
    if (!s?.x || !t?.x) return

    const isActive = activeNodeId && (s.id === activeNodeId || t.id === activeNodeId)
    const col = TYPE_COLOR[l.mtype] || '#888'

    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(t.x, t.y)

    if (l.mtype === 'verdict') {
      ctx.strokeStyle = l.target?.id === '__human__' || (typeof l.target === 'string' && l.target === '__human__')
        ? HUMAN_COLOR + '55' : BOT_COLOR + '55'
      ctx.lineWidth = 1.2
      ctx.setLineDash([4, 4])
    } else if (isActive) {
      ctx.strokeStyle = col + 'dd'
      ctx.lineWidth = 1.4
      ctx.setLineDash([])
    } else {
      ctx.strokeStyle = '#ffffff0a'
      ctx.lineWidth = 0.6
      ctx.setLineDash([])
    }
    ctx.stroke()
    ctx.setLineDash([])
  })

  // ── Particles ──────────────────────────────────────────────────────────────
  particles = particles.filter(p => p.t < 1)
  particles.forEach(p => {
    p.t += 0.018
    const ease = p.t < 0.5 ? 2 * p.t * p.t : -1 + (4 - 2 * p.t) * p.t
    const x = p.sx + (p.tx - p.sx) * ease
    const y = p.sy + (p.ty - p.sy) * ease
    const alpha = p.t < 0.8 ? 1 : 1 - (p.t - 0.8) / 0.2
    ctx.beginPath()
    ctx.arc(x, y, 2.5, 0, Math.PI * 2)
    ctx.fillStyle = p.color + Math.round(alpha * 220).toString(16).padStart(2, '0')
    ctx.shadowBlur = 6
    ctx.shadowColor = p.color
    ctx.fill()
    ctx.shadowBlur = 0
  })

  // ── Method nodes ───────────────────────────────────────────────────────────
  nodes.forEach(n => {
    if (!n.x || n.kind !== 'method') return
    const isActive = n.id === activeNodeId
    const col = TYPE_COLOR[n.type] || '#888'

    if (isActive) {
      ctx.shadowBlur = 18
      ctx.shadowColor = col
    }
    ctx.beginPath()
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
    ctx.fillStyle = isActive ? col : col + '55'
    ctx.fill()
    if (!isActive) {
      ctx.strokeStyle = col + '99'
      ctx.lineWidth = 0.8
      ctx.stroke()
    }
    ctx.shadowBlur = 0

    if (isActive) {
      ctx.fillStyle = col
      ctx.font = '7.5px monospace'
      ctx.textAlign = 'center'
      ctx.fillText(n.label, n.x, n.y - n.r - 5)
    }
  })

  // ── Brain node ─────────────────────────────────────────────────────────────
  const brain = nodes.find(n => n.id === '__brain__')
  if (brain?.x != null) {
    const pulse = brainPulse
    brainPulse = Math.max(0, brainPulse - 0.025)

    // Outer glow rings
    for (let i = 3; i >= 1; i--) {
      const rOff = i * 14 + pulse * 12
      const alpha = (0.06 - i * 0.015 + pulse * 0.06).toFixed(3)
      ctx.beginPath()
      ctx.arc(brain.x, brain.y, brain.r + rOff, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(200,200,255,${alpha})`
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // Core gradient
    const grad = ctx.createRadialGradient(brain.x, brain.y - 8, 2, brain.x, brain.y, brain.r + pulse * 8)
    grad.addColorStop(0, '#ffffff')
    grad.addColorStop(0.45, '#c8c8ff')
    grad.addColorStop(1, '#4444aa44')
    ctx.shadowBlur = 28 + pulse * 20
    ctx.shadowColor = '#8888ff'
    ctx.beginPath()
    ctx.arc(brain.x, brain.y, brain.r + pulse * 4, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()
    ctx.shadowBlur = 0

    // Label
    ctx.fillStyle = '#000010'
    ctx.font = 'bold 8px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('AI', brain.x, brain.y - 4)
    ctx.fillText('BRAIN', brain.x, brain.y + 6)

    // Role dots
    const roles = [{ lbl: 'E', col: '#f59e0b', dx: -12, dy: 20 }, { lbl: 'L', col: '#3b82f6', dx: 0, dy: 24 }, { lbl: 'C', col: '#8b5cf6', dx: 12, dy: 20 }]
    roles.forEach(({ lbl, col, dx, dy }) => {
      ctx.beginPath()
      ctx.arc(brain.x + dx, brain.y + dy, 6, 0, Math.PI * 2)
      ctx.fillStyle = col
      ctx.shadowBlur = 8
      ctx.shadowColor = col
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.fillStyle = '#000'
      ctx.font = 'bold 6px monospace'
      ctx.textAlign = 'center'
      ctx.fillText(lbl, brain.x + dx, brain.y + dy + 2)
    })
  }

  // ── Verdict nodes ──────────────────────────────────────────────────────────
  ;[
    { id: '__human__', label: 'HUMAN',   col: HUMAN_COLOR },
    { id: '__bot__',   label: 'BOT / AI', col: BOT_COLOR },
  ].forEach(({ id, label, col }) => {
    const n = nodes.find(x => x.id === id)
    if (!n?.x) return
    const bw = label.length * 6.5 + 20
    ctx.beginPath()
    ctx.roundRect(n.x - bw / 2, n.y - 14, bw, 28, 14)
    ctx.strokeStyle = col + 'aa'
    ctx.lineWidth = 1.5
    ctx.fillStyle = col + '18'
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = col
    ctx.font = 'bold 9px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(label, n.x, n.y + 4)
  })

  ctx.restore()
}

// ── Animation loop ────────────────────────────────────────────────────────────
function loop() {
  renderFrame()
  rafId = requestAnimationFrame(loop)
}

// ── Pulse: fire random signal every 1.8s ─────────────────────────────────────
function firePulse() {
  const methods = nodes.filter(n => n.kind === 'method' && n.x != null)
  if (!methods.length) return
  const pick = methods[Math.floor(Math.random() * methods.length)]
  const brain = nodes.find(n => n.id === '__brain__')
  activeNodeId = pick.id

  if (brain?.x != null) {
    const col = TYPE_COLOR[pick.type] || '#888'
    for (let i = 0; i < 3; i++) {
      setTimeout(() => particles.push({
        sx: pick.x + (Math.random() - 0.5) * 4,
        sy: pick.y + (Math.random() - 0.5) * 4,
        tx: brain.x, ty: brain.y,
        t: 0, color: col,
      }), i * 80)
    }
    setTimeout(() => { brainPulse = 1 }, 520)
  }

  setTimeout(() => { activeNodeId = null }, 900)
}

// ── Resize ────────────────────────────────────────────────────────────────────
function resize() {
  const wrap = wrapRef.value
  if (!wrap || !canvasRef.value) return
  const prevW = W
  W = wrap.clientWidth
  H = Math.max(420, Math.min(800, W * 0.95))
  canvasRef.value.width  = W
  canvasRef.value.height = H
  canvasRef.value.style.width  = W + 'px'
  canvasRef.value.style.height = H + 'px'
  if (prevW !== W) rebuild()
}

// ── Tooltip on hover ──────────────────────────────────────────────────────────
function onMouseMove(e) {
  const rect = canvasRef.value.getBoundingClientRect()
  const mx = e.clientX - rect.left - W / 2
  const my = e.clientY - rect.top  - H / 2

  const hit = nodes.find(n => {
    if (n.kind !== 'method' || !n.x) return false
    const dx = n.x - mx, dy = n.y - my
    return Math.sqrt(dx * dx + dy * dy) < n.r + 6
  })

  if (hit) {
    const m = props.methods.find(x => x.id === hit.id)
    tooltip.value = {
      x: e.clientX - rect.left + 10,
      y: e.clientY - rect.top  - 10,
      text: m?.description || hit.label,
    }
  } else {
    tooltip.value = null
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
function rebuild() {
  buildGraph()
  initSim()
}

watch(() => props.methods, (next, prev) => {
  if (!next?.length) return
  // Add only new nodes rather than full rebuild to preserve stable layout
  const prevIds = new Set(prev?.map(m => m.id) || [])
  const newMethods = next.filter(m => !prevIds.has(m.id))
  if (newMethods.length === 0) return
  rebuild()
}, { deep: false })

const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { resize(); renderFrame() }) : null

onMounted(async () => {
  await nextTick()
  resize()
  rebuild()
  loop()
  pulseTimer = setInterval(firePulse, 1800)
  ro?.observe(wrapRef.value)
  window.addEventListener('resize', resize)
})

onUnmounted(() => {
  cancelAnimationFrame(rafId)
  clearInterval(pulseTimer)
  sim?.stop()
  ro?.disconnect()
  window.removeEventListener('resize', resize)
})
</script>

<style scoped>
.bg-wrap {
  position: relative;
  width: 100%;
  user-select: none;
}

.bg-canvas {
  display: block;
  width: 100%;
}

.bg-tooltip {
  position: absolute;
  pointer-events: none;
  background: #0d0d1a;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 11px;
  color: #ccc;
  max-width: 260px;
  white-space: normal;
  line-height: 1.4;
  z-index: 10;
  transform: translateY(-100%);
}

.bg-stats {
  display: flex;
  justify-content: center;
  gap: 1.8rem;
  padding: 0.6rem 0 0.2rem;
  font-size: 11px;
  color: #555;
  letter-spacing: 0.06em;
  font-family: monospace;
}

.bg-stat {
  display: flex;
  align-items: center;
  gap: 6px;
}

.bg-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}
.bg-dot--evm    { background: #627EEA; box-shadow: 0 0 5px #627EEA; }
.bg-dot--rest   { background: #00D395; box-shadow: 0 0 5px #00D395; }
.bg-dot--solana { background: #9945FF; box-shadow: 0 0 5px #9945FF; }
</style>
