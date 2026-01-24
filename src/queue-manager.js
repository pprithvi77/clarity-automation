/**
 * Global Job Queue Manager
 *
 * Implements JOB-LEVEL queueing:
 * - Only ONE job runs at a time (not interleaved)
 * - Each job gets its own dedicated folder
 * - Webhook fires when job completes with folder path
 * - Subsequent jobs wait in queue until current job finishes
 *
 * Within a job, recordings can process in parallel (up to maxConcurrent).
 */

import pLimit from 'p-limit';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config.js';

// Job queue (FIFO)
const jobQueue = [];
let currentJob = null;
let isProcessing = false;

// Job tracking
const allJobs = new Map(); // jobId -> job details
let jobIdCounter = 0;

// Stats
let stats = {
  jobsCompleted: 0,
  jobsFailed: 0,
  recordingsProcessed: 0,
};

/**
 * Generate a unique job ID with timestamp
 * @returns {string} Job ID like "job_20250123_143022_001"
 */
function generateJobId() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `job_${timestamp}_${String(++jobIdCounter).padStart(3, '0')}`;
}

/**
 * Create dedicated folder for a job
 * @param {string} jobId - Job ID
 * @param {string} baseDir - Base recordings directory
 * @returns {string} Full path to job folder
 */
function createJobFolder(jobId, baseDir = './recordings') {
  const jobFolder = path.join(baseDir, jobId);
  if (!fs.existsSync(jobFolder)) {
    fs.mkdirSync(jobFolder, { recursive: true });
  }
  return jobFolder;
}

/**
 * Create a new job
 * @param {Object} options - Job options
 * @returns {Object} Job object with id, folder, etc.
 */
export function createJob(options = {}) {
  const jobId = generateJobId();
  const baseDir = options.outputDir || './recordings';
  const jobFolder = createJobFolder(jobId, baseDir);

  const job = {
    id: jobId,
    status: 'queued',
    folder: jobFolder,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    recordingsTotal: options.recordingsCount || 0,
    recordingsCompleted: 0,
    recordingsFailed: 0,
    results: [],
    error: null,
    webhookUrl: options.webhookUrl || null,
    uploadToGdrive: options.uploadToGdrive || false,
    metadata: options.metadata || {},
  };

  allJobs.set(jobId, job);
  console.log(`[JobQueue] Created job ${jobId} with folder: ${jobFolder}`);

  return job;
}

/**
 * Get job status
 * @param {string} jobId - Job ID
 * @returns {Object|null} Job object or null
 */
export function getJobStatus(jobId) {
  return allJobs.get(jobId) || null;
}

/**
 * Update job
 * @param {string} jobId - Job ID
 * @param {Object} updates - Fields to update
 */
export function updateJob(jobId, updates) {
  const job = allJobs.get(jobId);
  if (job) {
    Object.assign(job, updates);
  }
}

/**
 * Get queue status
 * @returns {Object} Queue statistics
 */
export function getQueueStats() {
  return {
    currentJob: currentJob ? {
      id: currentJob.id,
      status: currentJob.status,
      recordingsCompleted: currentJob.recordingsCompleted,
      recordingsTotal: currentJob.recordingsTotal,
    } : null,
    queueLength: jobQueue.length,
    queuedJobs: jobQueue.map(j => ({
      id: j.job.id,
      recordingsTotal: j.job.recordingsTotal,
    })),
    stats,
    maxConcurrent: config.processing.maxConcurrent,
  };
}

/**
 * Get all active/queued jobs
 * @returns {Array} List of jobs
 */
export function getActiveJobs() {
  const jobs = [];
  if (currentJob) jobs.push(currentJob);
  jobQueue.forEach(q => jobs.push(q.job));
  return jobs;
}

/**
 * Send webhook notification when job completes
 * @param {Object} job - Completed job
 */
async function sendWebhookNotification(job) {
  if (!job.webhookUrl) return;

  const payload = {
    event: 'job_completed',
    jobId: job.id,
    status: job.status,
    folder: job.folder,
    recordingsTotal: job.recordingsTotal,
    recordingsCompleted: job.recordingsCompleted,
    recordingsFailed: job.recordingsFailed,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    results: job.results,
    metadata: job.metadata,
  };

  try {
    console.log(`[JobQueue] Sending webhook to ${job.webhookUrl}`);
    const response = await fetch(job.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`[JobQueue] Webhook failed: ${response.status} ${response.statusText}`);
    } else {
      console.log(`[JobQueue] Webhook sent successfully`);
    }
  } catch (error) {
    console.error(`[JobQueue] Webhook error: ${error.message}`);
  }
}

/**
 * Process the next job in queue
 */
async function processNextJob() {
  if (isProcessing || jobQueue.length === 0) {
    return;
  }

  isProcessing = true;
  const { job, processFunction, resolve, reject } = jobQueue.shift();
  currentJob = job;

  console.log(`[JobQueue] Starting job ${job.id} (${job.recordingsTotal} recordings)`);
  console.log(`[JobQueue] Queue length: ${jobQueue.length} remaining`);

  try {
    // Update job status
    job.status = 'processing';
    job.startedAt = new Date().toISOString();

    // Run the job's process function
    const results = await processFunction(job);

    // Update job with results
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.results = results;
    job.recordingsCompleted = results.filter(r => r.success).length;
    job.recordingsFailed = results.filter(r => !r.success).length;

    stats.jobsCompleted++;
    stats.recordingsProcessed += results.length;

    console.log(`[JobQueue] Job ${job.id} completed: ${job.recordingsCompleted}/${job.recordingsTotal} successful`);

    // Send webhook notification
    await sendWebhookNotification(job);

    resolve({
      success: true,
      jobId: job.id,
      folder: job.folder,
      total: job.recordingsTotal,
      completed: job.recordingsCompleted,
      failed: job.recordingsFailed,
      results,
    });
  } catch (error) {
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = error.message;
    stats.jobsFailed++;

    console.error(`[JobQueue] Job ${job.id} failed: ${error.message}`);

    // Send webhook even on failure
    await sendWebhookNotification(job);

    reject(error);
  } finally {
    currentJob = null;
    isProcessing = false;

    // Clean up old jobs (keep last 50)
    cleanupOldJobs();

    // Process next job if any
    processNextJob();
  }
}

/**
 * Clean up old completed jobs
 */
function cleanupOldJobs() {
  const completed = Array.from(allJobs.entries())
    .filter(([, j]) => j.status === 'completed' || j.status === 'failed')
    .sort((a, b) => new Date(b[1].completedAt) - new Date(a[1].completedAt));

  if (completed.length > 50) {
    completed.slice(50).forEach(([id]) => allJobs.delete(id));
  }
}

/**
 * Queue a job for processing
 *
 * @param {Object} options - Job options
 * @param {Function} processFunction - Async function that processes the job
 *        Receives the job object, should return array of results
 * @returns {Promise} Resolves when job completes
 */
export function queueJob(options, processFunction) {
  return new Promise((resolve, reject) => {
    const job = createJob(options);

    jobQueue.push({
      job,
      processFunction,
      resolve,
      reject,
    });

    console.log(`[JobQueue] Job ${job.id} queued. Position: ${jobQueue.length}`);

    // Start processing if not already
    processNextJob();
  });
}

/**
 * Process recordings within a job (parallel within the job)
 *
 * @param {Array} recordings - Array of recording objects
 * @param {Function} processFunc - Function to process each recording
 * @param {Object} options - Options including maxConcurrent
 * @returns {Promise<Array>} Results
 */
export async function processRecordingsInJob(recordings, processFunc, options = {}) {
  const maxConcurrent = options.maxConcurrent || config.processing.maxConcurrent;
  const limit = pLimit(maxConcurrent);

  console.log(`[JobQueue] Processing ${recordings.length} recordings (max ${maxConcurrent} parallel)`);

  const promises = recordings.map((recording, index) =>
    limit(async () => {
      console.log(`[JobQueue] Starting recording ${index + 1}/${recordings.length}: ${recording.sessionId}`);
      try {
        const result = await processFunc(recording, index, recordings.length);
        console.log(`[JobQueue] Completed recording ${index + 1}/${recordings.length}: ${recording.sessionId}`);
        return result;
      } catch (error) {
        console.log(`[JobQueue] Failed recording ${index + 1}/${recordings.length}: ${recording.sessionId} - ${error.message}`);
        return {
          success: false,
          sessionId: recording.sessionId,
          error: error.message,
        };
      }
    })
  );

  return Promise.all(promises);
}

export default {
  createJob,
  getJobStatus,
  updateJob,
  getQueueStats,
  getActiveJobs,
  queueJob,
  processRecordingsInJob,
};
