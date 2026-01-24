#!/usr/bin/env node

/**
 * Clarity Recording Automation - Main Entry Point
 *
 * This module provides the core functionality for capturing Microsoft Clarity
 * session recordings using headless browser technology.
 */

export { config, validateConfig } from './config.js';
export {
  fetchDashboardInsights,
  fetchSessionRecordings,
  parseDuration,
  testConnection as testClarityConnection
} from './clarity-api.js';
export {
  connectToBrowserless,
  takeScreenshot,
  recordClaritySession,
  testConnection as testBrowserlessConnection
} from './browserless.js';
export {
  getAuthClient,
  authorizeInteractive,
  uploadFile,
  uploadRecording,
  createFolder,
  getOrCreateDateFolder,
  testConnection as testGoogleDriveConnection
} from './google-drive.js';
export { captureSingleRecording } from './capture-single.js';
export { captureBatch } from './capture-batch.js';

// CLI help
if (process.argv[1]?.includes('index.js')) {
  console.log(`
Clarity Recording Automation
=============================

This tool automates downloading Microsoft Clarity session recordings.

Available commands:
  npm run test:clarity      Test Clarity API connection
  npm run test:browserless  Test Browserless.io connection
  npm run auth:google       Authorize Google Drive access
  npm run capture:single    Capture a single recording
  npm run capture:batch     Capture multiple recordings

For more information, run any command with --help

Example workflow:
  1. Configure .env file with your API keys
  2. npm install
  3. npm run test:clarity
  4. npm run test:browserless
  5. npm run auth:google
  6. npm run capture:batch -- --count 10 --upload
`);
}
