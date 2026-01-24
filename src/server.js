#!/usr/bin/env node

/**
 * Express server for n8n integration
 * Provides HTTP endpoints for capturing Clarity recordings
 *
 * IMPORTANT: All capture endpoints require clarityCookies for authentication.
 * Export cookies from your browser while logged into Clarity.
 */

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { captureSingleRecording } from './capture-single.js';
import { config } from './config.js';
import { checkCookieExpiry, sendSlackExpiryNotification } from './cookie-utils.js';
import { getQueueStats, getJobStatus, getActiveJobs, queueJob, processRecordingsInJob } from './queue-manager.js';
import { fetchSessionRecordings, parseDuration } from './clarity-api.js';
import { recordClaritySession } from './browserless.js';
import { uploadRecording } from './google-drive.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  const queueStats = getQueueStats();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    config: {
      browserlessConfigured: !!config.browserless.apiKey,
      clarityConfigured: !!config.clarity.apiToken,
      googleDriveConfigured: !!config.googleDrive.clientId,
      slackConfigured: !!process.env.SLACK_WEBHOOK_URL,
      maxConcurrent: config.processing.maxConcurrent,
    },
    queue: {
      active: queueStats.active,
      pending: queueStats.pending,
      maxConcurrent: queueStats.maxConcurrent,
    },
  });
});

/**
 * Get queue status
 * GET /queue
 *
 * Returns current queue statistics and active jobs
 */
app.get('/queue', (req, res) => {
  const stats = getQueueStats();
  const activeJobs = getActiveJobs();

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    stats,
    activeJobs: activeJobs.map((job) => ({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      recordingsTotal: job.recordingsTotal,
      recordingsCompleted: job.recordingsCompleted,
      recordingsFailed: job.recordingsFailed,
    })),
  });
});

/**
 * Get specific job status
 * GET /queue/job/:jobId
 */
app.get('/queue/job/:jobId', (req, res) => {
  const job = getJobStatus(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: 'Job not found',
    });
  }

  res.json({
    success: true,
    job,
  });
});

/**
 * Check cookie expiry status
 * POST /cookies/check
 * Body: { clarityCookies, slackWebhookUrl?, notifyIfExpiringSoon? }
 *
 * Returns cookie expiry information and optionally sends Slack notification
 */
app.post('/cookies/check', async (req, res) => {
  const {
    clarityCookies,
    slackWebhookUrl = process.env.SLACK_WEBHOOK_URL,
    notifyIfExpiringSoon = true,
    thresholdDays = 7,
    projectName = 'Clarity',
    customerName = '',
  } = req.body;

  if (!clarityCookies) {
    return res.status(400).json({
      success: false,
      error: 'clarityCookies is required',
    });
  }

  try {
    const expiryInfo = checkCookieExpiry(clarityCookies);

    let notificationResult = null;

    // Send notification if cookies are expiring soon or expired
    if (notifyIfExpiringSoon && slackWebhookUrl) {
      const shouldNotify =
        expiryInfo.expired ||
        (expiryInfo.daysRemaining !== null && expiryInfo.daysRemaining <= thresholdDays);

      if (shouldNotify) {
        notificationResult = await sendSlackExpiryNotification(slackWebhookUrl, expiryInfo, {
          projectName,
          customerName,
        });
      }
    }

    res.json({
      success: true,
      ...expiryInfo,
      notificationSent: notificationResult?.success || false,
      notificationError: notificationResult?.error || null,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Send Slack notification about cookie status (manual trigger)
 * POST /cookies/notify
 * Body: { clarityCookies, slackWebhookUrl, projectName?, customerName? }
 */
app.post('/cookies/notify', async (req, res) => {
  const {
    clarityCookies,
    slackWebhookUrl = process.env.SLACK_WEBHOOK_URL,
    projectName = 'Clarity',
    customerName = '',
  } = req.body;

  if (!clarityCookies) {
    return res.status(400).json({
      success: false,
      error: 'clarityCookies is required',
    });
  }

  if (!slackWebhookUrl) {
    return res.status(400).json({
      success: false,
      error: 'slackWebhookUrl is required (or set SLACK_WEBHOOK_URL env var)',
    });
  }

  try {
    const expiryInfo = checkCookieExpiry(clarityCookies);
    const notificationResult = await sendSlackExpiryNotification(slackWebhookUrl, expiryInfo, {
      projectName,
      customerName,
    });

    res.json({
      success: notificationResult.success,
      ...expiryInfo,
      notificationError: notificationResult.error || null,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Capture a single recording
 * POST /capture
 * Body: { url, sessionId, uploadToGdrive, clarityToken, projectId, clarityCookies }
 *
 * IMPORTANT: clarityCookies is REQUIRED for authentication.
 * The Clarity web player requires browser session cookies to view recordings.
 * Export cookies using a browser extension while logged into Clarity.
 */
app.post('/capture', async (req, res) => {
  const {
    url,
    sessionId,
    uploadToGdrive = false,
    outputPath,
    // Allow overriding credentials per-request (for multi-customer support)
    clarityToken,
    projectId,
    // REQUIRED: Browser session cookies for Clarity authentication
    clarityCookies,
    // Optional: Slack notification for cookie expiry
    slackWebhookUrl = process.env.SLACK_WEBHOOK_URL,
  } = req.body;

  console.log(`[${new Date().toISOString()}] Capture request received`);
  console.log(`  URL: ${url || 'fetch latest'}`);
  console.log(`  Session ID: ${sessionId || 'auto'}`);
  console.log(`  Upload to GDrive: ${uploadToGdrive}`);
  console.log(`  Cookies provided: ${clarityCookies ? 'yes' : 'NO - will fail!'}`);

  // Validate cookies are provided
  if (!clarityCookies) {
    return res.status(400).json({
      success: false,
      error: 'clarityCookies is REQUIRED. Export cookies from your browser while logged into Clarity.',
    });
  }

  // Check cookie expiry and notify if expiring soon
  const expiryInfo = checkCookieExpiry(clarityCookies);

  if (expiryInfo.expired) {
    // Send Slack notification if configured
    if (slackWebhookUrl) {
      await sendSlackExpiryNotification(slackWebhookUrl, expiryInfo, {
        projectName: projectId || 'Clarity',
      }).catch(() => {});
    }

    return res.status(400).json({
      success: false,
      error: `Cookies have expired. Please export fresh cookies from Clarity.`,
      cookieExpiry: expiryInfo,
    });
  }

  // Warn about expiring cookies
  if (expiryInfo.daysRemaining !== null && expiryInfo.daysRemaining <= 7 && slackWebhookUrl) {
    // Send warning notification (fire and forget)
    sendSlackExpiryNotification(slackWebhookUrl, expiryInfo, {
      projectName: projectId || 'Clarity',
    }).catch(() => {});
  }

  try {
    // If custom credentials provided, temporarily override config
    const originalToken = config.clarity.apiToken;
    const originalProjectId = config.clarity.projectId;

    if (clarityToken) {
      config.clarity.apiToken = clarityToken;
    }
    if (projectId) {
      config.clarity.projectId = projectId;
    }

    const result = await captureSingleRecording({
      url,
      sessionId,
      uploadToGdrive,
      outputPath,
      clarityCookies,
    });

    // Restore original config
    config.clarity.apiToken = originalToken;
    config.clarity.projectId = originalProjectId;

    // Include cookie expiry info in response
    result.cookieExpiry = {
      daysRemaining: expiryInfo.daysRemaining,
      expiresAt: expiryInfo.expiresAt,
      warningLevel: expiryInfo.warningLevel,
    };

    console.log(`[${new Date().toISOString()}] Capture completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    res.json(result);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Capture error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

/**
 * Capture multiple recordings in batch with JOB-LEVEL queueing
 * POST /batch
 *
 * Body: {
 *   count: number,              // Max recordings to fetch (default: 10)
 *   maxConcurrent: number,      // Parallel recordings within job (default: 2)
 *   uploadToGdrive: boolean,    // Upload to Google Drive
 *   webhookUrl: string,         // Callback URL when job completes
 *   clarityCookies: array,      // REQUIRED: Browser cookies
 *   metadata: object,           // Custom data to include in webhook
 *   startDate: string,          // Filter: start date
 *   endDate: string,            // Filter: end date
 * }
 *
 * Response includes jobId and folder path.
 * Jobs are queued - only ONE job runs at a time.
 * Each job gets its own dedicated folder.
 * Webhook fires when job completes with folder path.
 */
app.post('/batch', async (req, res) => {
  const {
    count = 10,
    maxConcurrent = config.processing.maxConcurrent,
    uploadToGdrive = false,
    webhookUrl,
    clarityToken,
    projectId,
    startDate,
    endDate,
    clarityCookies,
    metadata = {},
    slackWebhookUrl = process.env.SLACK_WEBHOOK_URL,
  } = req.body;

  console.log(`[${new Date().toISOString()}] Batch capture request received`);
  console.log(`  Count: ${count}, Concurrency: ${maxConcurrent}`);
  console.log(`  Upload to GDrive: ${uploadToGdrive}`);
  console.log(`  Webhook URL: ${webhookUrl || 'none'}`);
  console.log(`  Cookies provided: ${clarityCookies ? 'yes' : 'NO - will fail!'}`);

  // Validate cookies
  if (!clarityCookies) {
    return res.status(400).json({
      success: false,
      error: 'clarityCookies is REQUIRED. Export cookies from your browser while logged into Clarity.',
    });
  }

  // Check cookie expiry
  const expiryInfo = checkCookieExpiry(clarityCookies);

  if (expiryInfo.expired) {
    if (slackWebhookUrl) {
      await sendSlackExpiryNotification(slackWebhookUrl, expiryInfo, {
        projectName: projectId || 'Clarity',
      }).catch(() => {});
    }

    return res.status(400).json({
      success: false,
      error: `Cookies have expired. Please export fresh cookies from Clarity.`,
      cookieExpiry: expiryInfo,
    });
  }

  // Warn about expiring cookies
  if (expiryInfo.daysRemaining !== null && expiryInfo.daysRemaining <= 7 && slackWebhookUrl) {
    sendSlackExpiryNotification(slackWebhookUrl, expiryInfo, {
      projectName: projectId || 'Clarity',
    }).catch(() => {});
  }

  try {
    // Override config if custom credentials provided
    const originalToken = config.clarity.apiToken;
    const originalProjectId = config.clarity.projectId;

    if (clarityToken) config.clarity.apiToken = clarityToken;
    if (projectId) config.clarity.projectId = projectId;

    // Fetch recordings first (before queueing)
    console.log(`[${new Date().toISOString()}] Fetching recordings...`);
    const recordings = await fetchSessionRecordings({
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      count,
    });

    // Restore config
    config.clarity.apiToken = originalToken;
    config.clarity.projectId = originalProjectId;

    if (recordings.length === 0) {
      return res.json({
        success: true,
        message: 'No recordings found for the specified criteria',
        total: 0,
        results: [],
      });
    }

    console.log(`[${new Date().toISOString()}] Found ${recordings.length} recordings, queueing job...`);

    // Queue the job - will wait if another job is running
    const result = await queueJob(
      {
        recordingsCount: recordings.length,
        uploadToGdrive,
        webhookUrl,
        metadata: {
          ...metadata,
          cookieExpiry: expiryInfo,
        },
      },
      async (job) => {
        // This runs when it's this job's turn
        console.log(`[${new Date().toISOString()}] Job ${job.id} starting processing`);

        // Process recordings function
        const processRecording = async (recording, index, total) => {
          const progress = `[${index + 1}/${total}]`;
          console.log(`${progress} Processing: ${recording.sessionId}`);

          try {
            const durationMs = parseDuration(recording.totalDuration) || 5 * 60 * 1000;

            // Capture recording
            const videoBuffer = await recordClaritySession(recording.playbackUrl, durationMs, {
              clarityCookies,
            });

            console.log(`${progress} Captured: ${recording.sessionId} (${videoBuffer.byteLength} bytes)`);

            // Save or upload
            if (uploadToGdrive) {
              const uploadResult = await uploadRecording(
                Buffer.from(videoBuffer),
                recording.sessionId,
                new Date(recording.timestamp)
              );
              return {
                success: true,
                sessionId: recording.sessionId,
                location: 'google-drive',
                fileId: uploadResult.fileId,
                webViewLink: uploadResult.webViewLink,
              };
            } else {
              // Save to job's dedicated folder
              const localPath = path.join(job.folder, `${recording.sessionId}.webm`);
              fs.writeFileSync(localPath, Buffer.from(videoBuffer));
              return {
                success: true,
                sessionId: recording.sessionId,
                location: 'local',
                path: localPath,
              };
            }
          } catch (error) {
            console.log(`${progress} Failed: ${recording.sessionId} - ${error.message}`);
            return {
              success: false,
              sessionId: recording.sessionId,
              error: error.message,
            };
          }
        };

        // Process all recordings (parallel within job)
        return processRecordingsInJob(recordings, processRecording, { maxConcurrent });
      }
    );

    console.log(`[${new Date().toISOString()}] Job ${result.jobId} completed`);

    res.json({
      success: true,
      jobId: result.jobId,
      folder: result.folder,
      total: result.total,
      completed: result.completed,
      failed: result.failed,
      results: result.results,
      cookieExpiry: {
        daysRemaining: expiryInfo.daysRemaining,
        expiresAt: expiryInfo.expiresAt,
        warningLevel: expiryInfo.warningLevel,
      },
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Batch error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get recording URLs from Clarity API
 * POST /recordings
 * Body: { count, startDate, endDate, clarityToken, projectId }
 */
app.post('/recordings', async (req, res) => {
  const { fetchSessionRecordings } = await import('./clarity-api.js');

  const { count = 50, startDate, endDate, clarityToken, projectId } = req.body;

  try {
    // Override config if custom credentials provided
    const originalToken = config.clarity.apiToken;
    if (clarityToken) {
      config.clarity.apiToken = clarityToken;
    }

    const recordings = await fetchSessionRecordings({
      count,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });

    config.clarity.apiToken = originalToken;

    res.json({
      success: true,
      count: recordings.length,
      recordings,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Webhook endpoint for external triggers
 * POST /webhook
 * Body: { action, payload }
 */
app.post('/webhook', async (req, res) => {
  const { action, payload } = req.body;

  console.log(`[${new Date().toISOString()}] Webhook received: ${action}`);

  switch (action) {
    case 'capture_single':
      // Redirect to /capture
      req.body = payload;
      return app._router.handle({ ...req, url: '/capture', method: 'POST' }, res, () => {});

    case 'capture_batch':
      req.body = payload;
      return app._router.handle({ ...req, url: '/batch', method: 'POST' }, res, () => {});

    case 'check_cookies':
      req.body = payload;
      return app._router.handle({ ...req, url: '/cookies/check', method: 'POST' }, res, () => {});

    default:
      res.status(400).json({
        success: false,
        error: `Unknown action: ${action}`,
      });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled error:`, err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message,
  });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log('========================================');
  console.log('Clarity Recording Capture Server');
  console.log('========================================');
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Max concurrent browser sessions: ${config.processing.maxConcurrent}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  GET  /health          - Health check + queue status`);
  console.log(`  GET  /queue           - Queue statistics & active jobs`);
  console.log(`  GET  /queue/job/:id   - Get specific job status`);
  console.log(`  POST /capture         - Capture single recording`);
  console.log(`  POST /batch           - Capture multiple recordings (uses global queue)`);
  console.log(`  POST /recordings      - Fetch recording URLs from Clarity API`);
  console.log(`  POST /cookies/check   - Check cookie expiry & optionally notify Slack`);
  console.log(`  POST /cookies/notify  - Send Slack notification about cookie status`);
  console.log(`  POST /webhook         - Webhook trigger`);
  console.log('');
  console.log('IMPORTANT: clarityCookies is REQUIRED for /capture and /batch');
  console.log('');
  console.log('GLOBAL QUEUE: All /batch requests share a single queue.');
  console.log(`Maximum ${config.processing.maxConcurrent} browser sessions run at a time,`);
  console.log('regardless of how many requests come in simultaneously.');
  console.log('');
});

export default app;
