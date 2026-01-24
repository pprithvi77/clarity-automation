#!/usr/bin/env node

/**
 * Interactive Google Drive authorization
 */

import { authorizeInteractive } from '../src/google-drive.js';

console.log('Starting Google Drive authorization...\n');

try {
  const client = await authorizeInteractive();
  console.log('\n✓ Google Drive authorization successful!');
  console.log('You can now use uploadToGdrive: true to upload recordings to Google Drive.');
} catch (error) {
  console.error('Authorization failed:', error.message);
  process.exit(1);
}
