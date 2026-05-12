'use strict';

require('dotenv').config();
const express = require('express');
const app = express();
const path = require('path');

app.use(express.json());
app.get('/config', (req, res) => {
  res.json({
    SOLANA_RPC:   process.env.SOLANA_RPC      || 'https://api.devnet.solana.com',
    POH_MINT:     process.env.POH_TOKEN_MINT  || '',
    VOTE_MINT:    process.env.VOTE_TOKEN_MINT || '',
    FEE_RECIPIENT: process.env.FEE_RECIPIENT  || '',
    STAKING_CONTRACT: process.env.STAKING_CONTRACT || '',
  });
});
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// Routes
app.use('/evm', require('./routes/evm'));
app.use('/rest', require('./routes/rest'));
app.use('/methods', require('./routes/methods'));
app.use('/checker', require('./routes/checker'));
app.use('/abi', require('./routes/abi'));
app.use('/profile', require('./routes/profile'));
app.use('/ecosystem', require('./routes/ecosystem'));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', endpoints: ['POST /evm', 'POST /rest'] });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Eval server listening on http://localhost:${PORT}`);

  // Ensure dedicated Ollama instance is running (non-blocking)
  require('../scripts/start-ollama').start();

  // Start background scheduler
  const { startScheduler } = require('./utils/scheduler');
  startScheduler();
});
