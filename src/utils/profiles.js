'use strict';

const fs = require('fs');
const path = require('path');

const PROFILES_PATH = path.join(__dirname, '../../data/profiles.json');
const REWARDS_PATH  = path.join(__dirname, '../../data/rewards.json');
const USED_TX_PATH  = path.join(__dirname, '../../data/used_tx.json');

// ── Profiles ──────────────────────────────────────────────────────────────────

function getProfiles() {
  if (!fs.existsSync(PROFILES_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveProfiles(data) {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(data, null, 2));
}

function getProfile(address) {
  return getProfiles()[address] || null;
}

function upsertProfile(address, patch) {
  const all = getProfiles();
  all[address] = { ...all[address], ...patch, address, updatedAt: new Date().toISOString() };
  saveProfiles(all);
  return all[address];
}

// ── Rewards ───────────────────────────────────────────────────────────────────

function getRewards() {
  if (!fs.existsSync(REWARDS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(REWARDS_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveRewards(data) {
  fs.writeFileSync(REWARDS_PATH, JSON.stringify(data, null, 2));
}

// ── Free scan tracking ────────────────────────────────────────────────────────
const FREE_SCANS_PER_WALLET = 100;

function getFreeScansLeft(address) {
  const p = getProfile(address);
  if (!p) return FREE_SCANS_PER_WALLET;
  return typeof p.freeScansLeft === 'number' ? p.freeScansLeft : FREE_SCANS_PER_WALLET;
}

function consumeFreeScan(address) {
  const left = getFreeScansLeft(address);
  if (left <= 0) return false;
  upsertProfile(address, {
    freeScansLeft: left - 1,
    totalScans: (getProfile(address)?.totalScans || 0) + 1,
  });
  return true;
}

// ── Bulk pricing curve ────────────────────────────────────────────────────────
// Returns cost in POH tokens (6 decimals, integer) for `count` addresses
function calcScanCost(count) {
  let rate;
  if (count >= 500)      rate = 0.40;
  else if (count >= 100) rate = 0.55;
  else if (count >= 50)  rate = 0.70;
  else if (count >= 10)  rate = 0.85;
  else                   rate = 1.00;
  const total = Math.ceil(count * rate * 1_000_000); // 6 decimals, round up
  return { total, rate, perAddress: rate };
}

// ── Reward distribution ───────────────────────────────────────────────────────
// 50% of pohPaid goes to method owners, weighted by method score/weight
function distributeRewards(pohPaid, executedMethodIds, allMethods, weights) {
  const pool = Math.floor(pohPaid * 0.5);
  if (pool <= 0 || !executedMethodIds.length) return;

  // Compute each method's weight share
  const scored = executedMethodIds.map(id => {
    const m = allMethods.find(m => m.id === id);
    const w = weights[id] ?? 1.0;
    const s = Math.max(0, (m?.score ?? 0) + 5); // shift so 0 score still gets share
    return { id, ownerWallet: m?.ownerWallet, score: s * w };
  }).filter(x => x.ownerWallet);

  const totalScore = scored.reduce((s, x) => s + x.score, 0);
  if (totalScore === 0) return;

  const rewards = getRewards();
  for (const { id, ownerWallet, score } of scored) {
    const share = Math.floor((score / totalScore) * pool);
    if (!rewards[id]) rewards[id] = { methodId: id, ownerWallet, totalEarned: 0, pendingWithdrawal: 0 };
    rewards[id].totalEarned += share;
    rewards[id].pendingWithdrawal += share;
    // Credit method owner's profile balance
    upsertProfile(ownerWallet, {
      balance: (getProfile(ownerWallet)?.balance || 0) + share,
    });
  }
  saveRewards(rewards);
}

// ── Staker reward distribution ────────────────────────────────────────────────
// Distributes poolRaw (6-decimal POH units) to stakers proportional to stake/total_staked.
// stakers: [{ address: string, stakedRaw: number }]
function distributeStakerRewards(poolRaw, stakers) {
  if (poolRaw <= 0 || !stakers.length) return;
  const totalStaked = stakers.reduce((s, x) => s + x.stakedRaw, 0);
  if (totalStaked === 0) return;

  for (const { address, stakedRaw } of stakers) {
    const share = Math.floor((stakedRaw / totalStaked) * poolRaw);
    if (share <= 0) continue;
    upsertProfile(address, {
      balance: (getProfile(address)?.balance || 0) + share,
    });
  }
}

// ── IP abuse check ────────────────────────────────────────────────────────────
// Returns true if this IP already has a different wallet with free scans used
function isIpAbuse(ip, address) {
  if (!ip) return false;
  const all = getProfiles();
  for (const [addr, p] of Object.entries(all)) {
    if (addr === address) continue;
    if ((p.ips || []).includes(ip) && (p.freeScansLeft ?? FREE_SCANS_PER_WALLET) < FREE_SCANS_PER_WALLET) {
      return true;
    }
  }
  return false;
}

function recordIp(address, ip) {
  if (!ip) return;
  const p = getProfile(address) || {};
  const ips = new Set(p.ips || []);
  ips.add(ip);
  upsertProfile(address, { ips: [...ips].slice(-20) }); // keep last 20 IPs
}

// ── Vote tracking ─────────────────────────────────────────────────────────────

function recordVote(address, methodId, vote) {
  const p = getProfile(address) || {};
  const votes = p.votes || {};
  votes[methodId] = { vote, at: new Date().toISOString() };
  upsertProfile(address, { votes });
}

function getMyVotes(address) {
  const p = getProfile(address);
  return p?.votes || {};
}

function hasVoted(address, methodId) {
  const p = getProfile(address);
  return !!p?.votes?.[methodId];
}

// ── txHash replay prevention ──────────────────────────────────────────────────

function _loadUsedTx() {
  try { return JSON.parse(fs.readFileSync(USED_TX_PATH, 'utf-8')); } catch { return {}; }
}

function isTxUsed(txHash) {
  return !!_loadUsedTx()[txHash];
}

function recordTx(txHash, context) {
  const used = _loadUsedTx();
  used[txHash] = { at: new Date().toISOString(), ...context };
  fs.writeFileSync(USED_TX_PATH, JSON.stringify(used, null, 2));
}

module.exports = {
  getProfile, upsertProfile, getProfiles,
  getRewards, saveRewards,
  getFreeScansLeft, consumeFreeScan,
  calcScanCost, distributeRewards, distributeStakerRewards,
  isIpAbuse, recordIp,
  recordVote, getMyVotes, hasVoted,
  isTxUsed, recordTx,
  FREE_SCANS_PER_WALLET,
};
