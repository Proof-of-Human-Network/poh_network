'use strict';

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');

const FILE = path.join(__dirname, '../../data/ecosystem.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}
function adminGuard(req, res) {
  const secret = req.headers['x-admin-secret'] || req.body?.adminSecret;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// GET /ecosystem — public: approved projects only
router.get('/', (req, res) => {
  const all = load();
  res.json(all.filter(p => p.status === 'approved'));
});

// POST /ecosystem/apply — submit a new application
router.post('/apply', (req, res) => {
  const { name, website, logo, description, integration, contact } = req.body;
  if (!name?.trim() || !website?.trim() || !description?.trim() || !integration?.trim() || !contact?.trim())
    return res.status(400).json({ error: 'name, website, description, integration and contact are required' });

  const all = load();
  const entry = {
    id: `${Date.now()}_${name.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 20)}`,
    name:        name.trim(),
    website:     website.trim(),
    logo:        logo?.trim() || '',
    description: description.trim(),
    integration: integration.trim(),
    contact:     contact.trim(),
    status:      'pending',
    created_at:  new Date().toISOString(),
    approved_at: null,
  };
  all.push(entry);
  save(all);
  res.json({ status: 'submitted', id: entry.id });
});

// GET /ecosystem/pending — admin: all pending applications
router.get('/pending', (req, res) => {
  if (!adminGuard(req, res)) return;
  res.json(load().filter(p => p.status === 'pending'));
});

// POST /ecosystem/approve/:id — admin: approve a project
router.post('/approve/:id', (req, res) => {
  if (!adminGuard(req, res)) return;
  const all = load();
  const p = all.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.status      = 'approved';
  p.approved_at = new Date().toISOString();
  save(all);
  res.json({ status: 'approved', project: p });
});

// DELETE /ecosystem/:id — admin: reject / remove a project
router.delete('/:id', (req, res) => {
  if (!adminGuard(req, res)) return;
  const all = load();
  const idx = all.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [removed] = all.splice(idx, 1);
  save(all);
  res.json({ status: 'removed', id: removed.id });
});

module.exports = router;
