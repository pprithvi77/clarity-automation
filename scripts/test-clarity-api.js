#!/usr/bin/env node

/**
 * Test Clarity API connectivity
 */

import { testConnection } from '../src/clarity-api.js';

console.log('Testing Clarity API connection...\n');

try {
  const results = await testConnection();

  console.log('Dashboard API:', results.dashboardApi.success ? '✓ Connected' : '✗ Failed');
  if (results.dashboardApi.error) {
    console.log('  Error:', results.dashboardApi.error);
  } else if (results.dashboardApi.sessionCount) {
    console.log('  Sessions:', results.dashboardApi.sessionCount);
  }

  console.log('\nRecordings API:', results.recordingsApi.success ? '✓ Connected' : '✗ Failed');
  if (results.recordingsApi.error) {
    console.log('  Error:', results.recordingsApi.error);
  } else if (results.recordingsApi.sampleUrl) {
    console.log('  Sample URL:', results.recordingsApi.sampleUrl);
  }

  const allPassed = results.dashboardApi.success && results.recordingsApi.success;
  console.log('\n' + (allPassed ? '✓ All tests passed!' : '✗ Some tests failed'));
  process.exit(allPassed ? 0 : 1);
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
