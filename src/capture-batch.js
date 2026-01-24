#!/usr/bin/env node

/**
 * Batch capture multiple Clarity recordings with parallel processing
 * Run with: npm run capture:batch -- --cookies <path-to-cookies.json>
 */

import pLimit from 'p-limit';
import { config, validateConfig } from './config.js';
import { fetchSessionRecordings, parseDuration } from './clarity-api.js';
import { recordClaritySession } from './browserless.js';
import { uploadRecording } from './google-drive.js';
import { queueBrowserTask, createJob, updateJob } from './queue-manager.js';
import * as fs from 'fs';
import * as path from 'path';

// Default cookies file path
const DEFAULT_COOKIES_PATH = path.join(process.cwd(), 'clarity-cookies.json');

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

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxAttempts - Maximum number of attempts
 * @returns {Promise} Result of the function
 */
async function withRetry(fn, maxAttempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.log(`    Attempt ${attempt}/${maxAttempts} failed: ${error.message}`);

      if (attempt < maxAttempts) {
        // Exponential backoff: 5s, 15s, 45s
        const delay = 5000 * Math.pow(3, attempt - 1);
        console.log(`    Retrying in ${delay / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Process a single recording (used in parallel)
 * @param {Object} recording - Recording info
 * @param {number} index - Recording index
 * @param {number} total - Total recordings
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Processing result
 */
async function processRecording(recording, index, total, options) {
  const { uploadToGdrive, outputDir, clarityCookies } = options;
  const progress = `[${index + 1}/${total}]`;

  console.log(`${progress} Starting: ${recording.sessionId}`);
  console.log(`  Duration: ${recording.totalDuration}`);
  console.log(`  URL: ${recording.playbackUrl}`);

  try {
    // Estimate duration from the API response
    const durationMs = parseDuration(recording.totalDuration) || 5 * 60 * 1000;

    // Capture with retry (pass cookies for authentication)
    const videoBuffer = await withRetry(async () => {
      return recordClaritySession(recording.playbackUrl, durationMs, {
        clarityCookies,
      });
    }, config.processing.retryAttempts);

    console.log(`${progress} Captured: ${recording.sessionId} (${videoBuffer.byteLength} bytes)`);

    // Upload or save
    let result;
    if (uploadToGdrive) {
      const uploadResult = await uploadRecording(
        Buffer.from(videoBuffer),
        recording.sessionId,
        new Date(recording.timestamp)
      );
      result = {
        success: true,
        sessionId: recording.sessionId,
        location: 'google-drive',
        fileId: uploadResult.fileId,
        webViewLink: uploadResult.webViewLink,
      };
      console.log(`${progress} ✓ Uploaded: ${recording.sessionId}`);
    } else {
      const localPath = path.join(outputDir, `${recording.sessionId}.webm`);
      fs.writeFileSync(localPath, Buffer.from(videoBuffer));
      result = {
        success: true,
        sessionId: recording.sessionId,
        location: 'local',
        path: localPath,
      };
      console.log(`${progress} ✓ Saved: ${recording.sessionId}`);
    }

    return result;
  } catch (error) {
    console.log(`${progress} ✗ Failed: ${recording.sessionId} - ${error.message}`);
    return {
      success: false,
      sessionId: recording.sessionId,
      error: error.message,
    };
  }
}

/**
 * Capture multiple recordings in batch with parallel processing
 * @param {Object} options - Batch options
 * @param {Date} options.startDate - Start date for recordings
 * @param {Date} options.endDate - End date for recordings
 * @param {number} options.maxCount - Maximum recordings to process
 * @param {number} options.maxConcurrent - Maximum concurrent recordings (default: from config)
 * @param {boolean} options.uploadToGdrive - Upload to Google Drive
 * @param {string} options.outputDir - Local output directory
 * @param {string|Array} options.clarityCookies - Browser session cookies for authentication
 * @param {boolean} options.useGlobalQueue - Use global queue (true for server, false for CLI)
 * @param {string} options.jobId - Job ID for tracking (auto-created if useGlobalQueue)
 * @returns {Promise<Object>} Batch results
 */
export async function captureBatch({
  startDate,
  endDate,
  maxCount = config.processing.maxRecordingsPerBatch,
  maxConcurrent = config.processing.maxConcurrent,
  uploadToGdrive = false,
  outputDir = './recordings',
  clarityCookies,
  useGlobalQueue = false,
  jobId = null,
} = {}) {
  console.log('Starting batch capture...\n');
  console.log(`Concurrency: ${maxConcurrent} parallel recordings`);
  console.log(`Queue mode: ${useGlobalQueue ? 'GLOBAL (shared across all requests)' : 'LOCAL (this request only)'}\n`);

  // Fetch recordings
  console.log('Fetching session recordings...');
  const recordings = await fetchSessionRecordings({
    startDate,
    endDate,
    count: maxCount,
  });

  console.log(`Found ${recordings.length} recordings\n`);

  if (recordings.length === 0) {
    return {
      total: 0,
      success: 0,
      failed: 0,
      results: [],
      jobId: null,
    };
  }

  // Create output directory if saving locally
  if (!uploadToGdrive && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create job for tracking if using global queue
  if (useGlobalQueue && !jobId) {
    jobId = createJob({ recordingsCount: recordings.length });
    console.log(`Job created: ${jobId}\n`);
  }

  let results;

  if (useGlobalQueue) {
    // Use global queue - respects limits across ALL concurrent API requests
    if (jobId) {
      updateJob(jobId, {
        status: 'processing',
        startedAt: new Date().toISOString(),
        recordingsTotal: recordings.length,
      });
    }

    const promises = recordings.map((recording, index) =>
      queueBrowserTask(
        () =>
          processRecording(recording, index, recordings.length, {
            uploadToGdrive,
            outputDir,
            clarityCookies,
          }),
        { jobId, recordingId: recording.sessionId }
      ).catch((error) => ({
        success: false,
        sessionId: recording.sessionId,
        error: error.message,
      }))
    );

    results = await Promise.all(promises);

    if (jobId) {
      updateJob(jobId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        results,
      });
    }
  } else {
    // Use local limiter - only limits within THIS request (CLI mode)
    const limit = pLimit(maxConcurrent);

    const promises = recordings.map((recording, index) =>
      limit(() =>
        processRecording(recording, index, recordings.length, {
          uploadToGdrive,
          outputDir,
          clarityCookies,
        })
      )
    );

    results = await Promise.all(promises);
  }

  // Count successes and failures
  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.filter((r) => !r.success).length;

  return {
    total: recordings.length,
    success: successCount,
    failed: failedCount,
    results,
    jobId,
  };
}

// CLI execution
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let startDate = null;
  let endDate = null;
  let maxCount = config.processing.maxRecordingsPerBatch;
  let maxConcurrent = config.processing.maxConcurrent;
  let uploadToGdrive = false;
  let outputDir = './recordings';
  let cookiesPath = DEFAULT_COOKIES_PATH;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start':
      case '-s':
        startDate = new Date(args[++i]);
        break;
      case '--end':
      case '-e':
        endDate = new Date(args[++i]);
        break;
      case '--count':
        maxCount = parseInt(args[++i]);
        break;
      case '--concurrent':
      case '-p':
        maxConcurrent = parseInt(args[++i]);
        break;
      case '--upload':
      case '-g':
        uploadToGdrive = true;
        break;
      case '--output':
      case '-o':
        outputDir = args[++i];
        break;
      case '--cookies':
      case '-c':
        cookiesPath = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
Batch capture Clarity recordings with parallel processing

Usage: npm run capture:batch -- [options]

Options:
  --start, -s <date>      Start date (ISO format, default: 7 days ago)
  --end, -e <date>        End date (ISO format, default: now)
  --count <num>           Maximum recordings to capture (default: ${config.processing.maxRecordingsPerBatch})
  --concurrent, -p <num>  Parallel recordings (default: ${config.processing.maxConcurrent}, match your Browserless plan)
  --upload, -g            Upload to Google Drive instead of saving locally
  --output, -o <dir>      Local output directory (default: ./recordings)
  --cookies, -c <path>    Path to cookies JSON file (default: ./clarity-cookies.json)
  --help, -h              Show this help message

IMPORTANT: Clarity session cookies are REQUIRED for authentication.
Export cookies using a browser extension (like EditThisCookie) while logged into Clarity.

Examples:
  npm run capture:batch -- --cookies cookies.json
  npm run capture:batch -- --count 10 --concurrent 2 -c cookies.json
  npm run capture:batch -- --start 2025-01-15 --end 2025-01-19 --upload -c cookies.json
  npm run capture:batch -- --count 50 -g --concurrent 3 --cookies my-cookies.json
`);
        process.exit(0);
    }
  }

  console.log('========================================');
  console.log('Clarity Recording Capture - Batch');
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

  console.log(`Loaded cookies from: ${cookiesPath}`);
  console.log(`Max recordings: ${maxCount}`);
  console.log(`Parallel recordings: ${maxConcurrent}`);
  console.log(`Start date: ${startDate || 'Last 7 days'}`);
  console.log(`End date: ${endDate || 'Now'}`);
  console.log(`Destination: ${uploadToGdrive ? 'Google Drive' : outputDir}`);
  console.log('');

  const startTime = Date.now();
  const result = await captureBatch({
    startDate,
    endDate,
    maxCount,
    maxConcurrent,
    uploadToGdrive,
    outputDir,
    clarityCookies,
  });
  const duration = Math.round((Date.now() - startTime) / 1000);

  console.log('\n========================================');
  console.log('Batch Complete');
  console.log('========================================');
  console.log(`Total: ${result.total}`);
  console.log(`Success: ${result.success}`);
  console.log(`Failed: ${result.failed}`);
  console.log(`Duration: ${duration}s`);
  console.log(`Effective rate: ${result.total > 0 ? Math.round(duration / result.total) : 0}s per recording`);

  if (result.failed > 0) {
    console.log('\nFailed recordings:');
    result.results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`  - ${r.sessionId}: ${r.error}`);
      });
  }

  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
