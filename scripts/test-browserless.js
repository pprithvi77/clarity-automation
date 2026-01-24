#!/usr/bin/env node

/**
 * Test Browserless.io connectivity
 */

import { testConnection } from '../src/browserless.js';

console.log('Testing Browserless.io connection...\n');

try {
  const results = await testConnection();

  console.log('WebSocket:', results.websocket.success ? '✓ Connected' : '✗ Failed');
  if (results.websocket.error) {
    console.log('  Error:', results.websocket.error);
  }

  console.log('\nREST API:', results.restApi.success ? '✓ Connected' : '✗ Failed');
  if (results.restApi.error) {
    console.log('  Error:', results.restApi.error);
  }

  const allPassed = results.websocket.success && results.restApi.success;
  console.log('\n' + (allPassed ? '✓ All tests passed!' : '✗ Some tests failed'));
  process.exit(allPassed ? 0 : 1);
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
