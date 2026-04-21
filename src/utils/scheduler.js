'use strict';

const cron = require('node-cron');
const { consolidate } = require('./brain');

function startScheduler() {
  // Consolidate brain state every hour
  cron.schedule('0 * * * *', async () => {
    console.log('[scheduler] Starting brain consolidation...');
    try {
      await consolidate();
    } catch (err) {
      console.error('[scheduler] Consolidation failed:', err.message);
    }
  });

  console.log('[scheduler] Brain consolidation scheduled (hourly).');
}

module.exports = { startScheduler };
