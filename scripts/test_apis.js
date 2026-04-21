'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';

// Mocking Solana payment for testing purposes
// In a real test, we would use a library like 'sinon' or 'jest' to mock
// but for this standalone script, we'll just explain that the server
// needs to be running with a mock-friendly configuration or we skip the payment check.

async function runTests() {
  console.log('--- Starting API Tests ---');

  try {
    // 1. Test Listing API
    console.log('\n[1] Testing Listing API (Single)');
    const listingRes = await axios.post(`${BASE_URL}/methods/listing`, {
      type: 'evm',
      chainId: 1,
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      method: '0x70a08231',
      abiTypes: '["address"]',
      returnTypes: '["uint256"]',
      expression: 'result[0] > 0n',
      description: 'Test USDC Check',
      txHash: 'MOCK_SUCCESS', // Server utility needs to handle this mock
      walletAddress: '6vYV...'
    });
    console.log('Listing Success:', listingRes.data);

    const methodId = (await axios.get(`${BASE_URL}/methods/verifyer`)).data[0].id;

    // 2. Test Voting API
    console.log('\n[2] Testing Verifyer/Vote API');
    const voteRes = await axios.post(`${BASE_URL}/methods/verifyer/vote`, {
      methodId,
      type: 'description',
      vote: true,
      walletAddress: '6vYV...',
      txHash: 'MOCK_SUCCESS'
    });
    console.log('Vote Success:', voteRes.data);

    // 3. Test Checker API
    console.log('\n[3] Testing Checker API');
    const checkerRes = await axios.post(`${BASE_URL}/checker`, {
      input: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      walletAddress: '6vYV...',
      txHash: 'MOCK_SUCCESS'
    });
    console.log('Checker Success:', checkerRes.data);

    console.log('\n--- All Tests Finished ---');
  } catch (err) {
    console.error('Test Failed:', err.response ? err.response.data : err.message);
  }
}

runTests();
