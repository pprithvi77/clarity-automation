#!/usr/bin/env node

/**
 * Capture a single Clarity recording
 * Run with: npm run capture:single -- --url <clarity-url> --cookies <path-to-cookies.json>
 */

import { config, validateConfig } from './config.js';
import { fetchSessionRecordings, parseDuration } from './clarity-api.js';
import { recordClaritySession } from './browserless.js';
import { uploadRecording } from './google-drive.js';
import * as fs from 'fs';
import * as path from 'path';

// Default cookies file path
const DEFAULT_COOKIES_PATH = path.join(process.cwd(), 'clarity-cookies.json');

/**
 * Capture a single recording
 * @param {Object} options - Capture options
 * @param {string} options.url - Clarity playback URL (optional, will fetch latest if not provided)
 * @param {string} options.sessionId - Session ID (optional)
 * @param {boolean} options.uploadToGdrive - Whether to upload to Google Drive
 * @param {string} options.outputPath - Local output path (if not uploading)
 * @param {string|Array} options.clarityCookies - Browser session cookies for Clarity authentication
 * @returns {Promise<Object>} Capture result
 */
export async function captureSingleRecording({
  url,
  sessionId,
  uploadToGdrive = false,
  outputPath,
  clarityCookies,
} = {}) {
  console.log('Starting single recording capture...\n');

  let recordingDurationMs = 60 * 1000; // Default 1 minute if unknown

  // If no URL provided, fetch the latest recording
  if (!url) {
    console.log('No URL provided, fetching latest recording...');
    const recordings = await fetchSessionRecordings({ count: 1 });

    if (recordings.length === 0) {
      throw new Error('No recordings found');
    }

    const recording = recordings[0];
    url = recording.playbackUrl;
    sessionId = recording.sessionId;

    // Parse the actual duration from the API response
    if (recording.totalDuration) {
      recordingDurationMs = parseDuration(recording.totalDuration) || 60000;
    }

    console.log(`Found recording: ${sessionId}`);
    console.log(`Duration: ${recording.totalDuration} (${recordingDurationMs}ms)`);
    console.log(`URL: ${url}\n`);
  }

  // Extract session ID from URL if not provided
  if (!sessionId) {
    const urlParts = url.split('/');
    sessionId = urlParts[urlParts.length - 2];
  }

  console.log(`Session ID: ${sessionId}`);
  console.log(`Playback URL: ${url}\n`);

  // Use the actual duration plus buffer for page load
  const estimatedDurationMs = recordingDurationMs;

  console.log('Starting screen recording...');
  console.log('This may take several minutes depending on the recording length.\n');

  try {
    // Record the session (pass cookies for authentication)
    const videoBuffer = await recordClaritySession(url, estimatedDurationMs, {
      clarityCookies,
    });

    console.log(`Recording captured: ${videoBuffer.byteLength} bytes`);

    // Save or upload
    if (uploadToGdrive) {
      console.log('\nUploading to Google Drive...');
      const uploadResult = await uploadRecording(
        Buffer.from(videoBuffer),
        sessionId
      );
      console.log(`✓ Uploaded: ${uploadResult.webViewLink}`);
      return {
        success: true,
        sessionId,
        location: 'google-drive',
        fileId: uploadResult.fileId,
        webViewLink: uploadResult.webViewLink,
      };
    } else {
      // Save locally
      const localPath = outputPath || path.join(process.cwd(), `${sessionId}.webm`);
      fs.writeFileSync(localPath, Buffer.from(videoBuffer));
      console.log(`✓ Saved locally: ${localPath}`);
      return {
        success: true,
        sessionId,
        location: 'local',
        path: localPath,
      };
    }
  } catch (error) {
    console.error(`✗ Capture failed: ${error.message}`);
    return {
      success: false,
      sessionId,
      error: error.message,
    };
  }
}

/**
 * Load cookies from file
 * @param {string} cookiesPath - Path to cookies file
 * @returns {Array|null} Parsed cookies or null
 */
function loadCookiesFromFile(cookiesPath) {
  try {
    if (fs.existsSync(cookiesPath)) {
      const content = fs.readFileSync(cookiesPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error(`Failed to load cookies from ${cookiesPath}: ${error.message}`);
  }
  return null;
}

// CLI execution
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let url = null;
  let uploadToGdrive = false;
  let outputPath = null;
  let cookiesPath = DEFAULT_COOKIES_PATH;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
      case '-u':
        url = args[++i];
        break;
      case '--upload':
      case '-g':
        uploadToGdrive = true;
        break;
      case '--output':
      case '-o':
        outputPath = args[++i];
        break;
      case '--cookies':
      case '-c':
        cookiesPath = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
Capture a single Clarity recording

Usage: npm run capture:single -- [options]

Options:
  --url, -u <url>         Clarity playback URL (optional, fetches latest if not provided)
  --upload, -g            Upload to Google Drive instead of saving locally
  --output, -o <path>     Local output path (default: ./<sessionId>.webm)
  --cookies, -c <path>    Path to cookies JSON file (default: ./clarity-cookies.json)
  --help, -h              Show this help message

IMPORTANT: Clarity session cookies are REQUIRED for authentication.
Export cookies using a browser extension (like EditThisCookie) while logged into Clarity.

Examples:
  npm run capture:single -- --cookies cookies.json
  npm run capture:single -- --url "https://clarity.microsoft.com/player/xyz/abc/123" -c cookies.json
  npm run capture:single -- --upload --cookies my-cookies.json
  npm run capture:single -- -o recordings/my-recording.webm -c cookies.json
`);
        process.exit(0);
    }
  }

  console.log('========================================');
  console.log('Clarity Recording Capture - Single');
  console.log('========================================\n');

  try {
    validateConfig();
  } catch (error) {
    console.error('Configuration error:', error.message);
    process.exit(1);
  }

  // Load cookies
  const clarityCookies = loadCookiesFromFile(cookiesPath);

  if (!clarityCookies) {
    console.error(`\nERROR: Could not load cookies from ${cookiesPath}`);
    console.error('');
    console.error('Clarity requires browser session cookies for authentication.');
    console.error('Please export your cookies while logged into Clarity:');
    console.error('  1. Install a cookie export extension (e.g., EditThisCookie)');
    console.error('  2. Log into clarity.microsoft.com');
    console.error('  3. Export cookies as JSON to clarity-cookies.json');
    console.error('  4. Run this command again');
    process.exit(1);
  }

  console.log(`Loaded cookies from: ${cookiesPath}\n`);

  const result = await captureSingleRecording({
    url,
    uploadToGdrive,
    outputPath,
    clarityCookies,
  });

  console.log('\n========================================');
  console.log('Result');
  console.log('========================================');
  console.log(JSON.stringify(result, null, 2));

  process.exit(result.success ? 0 : 1);
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
