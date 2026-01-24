import 'dotenv/config';

export const config = {
  // Microsoft Clarity
  clarity: {
    projectId: process.env.CLARITY_PROJECT_ID,
    apiToken: process.env.CLARITY_API_TOKEN,
    baseUrl: 'https://clarity.microsoft.com',
    mcpBaseUrl: 'https://clarity.microsoft.com/mcp',
  },

  // Browserless.io
  browserless: {
    apiKey: process.env.BROWSERLESS_API_KEY,
    endpoint: process.env.BROWSERLESS_ENDPOINT || 'https://production-sfo.browserless.io',
  },

  // Google Drive
  googleDrive: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
  },

  // Processing
  processing: {
    maxRecordingsPerBatch: parseInt(process.env.MAX_RECORDINGS_PER_BATCH) || 100,
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_RECORDINGS) || 2, // Match your Browserless plan
    recordingTimeoutMinutes: parseInt(process.env.RECORDING_TIMEOUT_MINUTES) || 35,
    retryAttempts: parseInt(process.env.RETRY_ATTEMPTS) || 3,
    delayBetweenRecordings: 5000, // 5 seconds
  },

  // Notifications
  notifications: {
    type: process.env.NOTIFICATION_TYPE || 'none',
    email: process.env.NOTIFICATION_EMAIL,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  },
};

// Validation
export function validateConfig() {
  const errors = [];

  if (!config.clarity.projectId) {
    errors.push('CLARITY_PROJECT_ID is required');
  }
  if (!config.clarity.apiToken) {
    errors.push('CLARITY_API_TOKEN is required');
  }
  if (!config.browserless.apiKey) {
    errors.push('BROWSERLESS_API_KEY is required');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.join('\n')}`);
  }

  return true;
}
