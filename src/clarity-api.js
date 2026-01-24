import { config } from './config.js';

/**
 * Fetch with timeout
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch dashboard insights from Clarity Data Export API
 * @param {number} numOfDays - 1, 2, or 3 (last 24, 48, or 72 hours)
 * @param {string} dimension1 - Optional dimension (Browser, Device, Country, OS, etc.)
 * @returns {Promise<Array>} Dashboard metrics
 */
export async function fetchDashboardInsights(numOfDays = 1, dimension1 = null) {
  const params = new URLSearchParams({ numOfDays: numOfDays.toString() });
  if (dimension1) {
    params.append('dimension1', dimension1);
  }

  const url = `https://www.clarity.ms/export-data/api/v1/project-live-insights?${params}`;

  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${config.clarity.apiToken}`,
      'Content-Type': 'application/json',
    },
  }, 30000);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Clarity API error (${response.status}): ${error}`);
  }

  return response.json();
}

/**
 * Fetch session recordings from Clarity MCP API
 * @param {Object} options - Query options
 * @param {Date} options.startDate - Start date for recordings
 * @param {Date} options.endDate - End date for recordings
 * @param {number} options.count - Number of recordings to fetch (max 250)
 * @param {number} options.sortBy - Sort option (0=newest first, 1=oldest first, etc.)
 * @param {Object} options.filters - Additional filters
 * @returns {Promise<Array>} Session recordings with playback URLs
 */
export async function fetchSessionRecordings({
  startDate,
  endDate,
  count = 100,
  sortBy = 0,
  filters = {},
} = {}) {
  // Default to last 7 days if no dates provided
  const now = new Date();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 7);

  const start = startDate || defaultStart;
  const end = endDate || now;

  const url = `${config.clarity.mcpBaseUrl}/recordings/sample`;

  const body = {
    sortBy,
    start: start.toISOString(),
    end: end.toISOString(),
    count: Math.min(count, 250), // API max is 250
    ...filters,
  };

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.clarity.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, 90000); // 90 second timeout for recordings API

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Clarity MCP API error (${response.status}): ${error}`);
  }

  const recordings = await response.json();

  // Transform to a cleaner format
  return recordings.map((recording) => ({
    playbackUrl: recording.link,
    sessionId: extractSessionId(recording.link),
    timestamp: recording.timestamp,
    totalDuration: recording.totalDuration,
    activeDuration: recording.activeDuration,
    pagesCount: recording.pagesCount,
    clickCount: recording.sessionClickCount,
    timeline: recording.timeline,
  }));
}

/**
 * Extract session ID from Clarity player URL
 * @param {string} url - Clarity player URL
 * @returns {string} Session ID
 */
function extractSessionId(url) {
  // URL format: https://clarity.microsoft.com/player/{projectId}/{sessionId}/{recordingId}
  const parts = url.split('/');
  return parts[parts.length - 2]; // Session ID is second to last
}

/**
 * Parse duration string to milliseconds
 * @param {string} durationStr - Duration string like "05 minutes and 04 seconds"
 * @returns {number} Duration in milliseconds
 */
export function parseDuration(durationStr) {
  let totalMs = 0;

  const minutesMatch = durationStr.match(/(\d+)\s*minutes?/);
  const secondsMatch = durationStr.match(/(\d+)\s*seconds?/);

  if (minutesMatch) {
    totalMs += parseInt(minutesMatch[1]) * 60 * 1000;
  }
  if (secondsMatch) {
    totalMs += parseInt(secondsMatch[1]) * 1000;
  }

  return totalMs;
}

/**
 * Test API connectivity
 * @returns {Promise<Object>} Test results
 */
export async function testConnection() {
  const results = {
    dashboardApi: { success: false, error: null },
    recordingsApi: { success: false, error: null },
  };

  // Test dashboard API
  try {
    const insights = await fetchDashboardInsights(1);
    results.dashboardApi.success = true;
    results.dashboardApi.sessionCount = insights.find(
      (m) => m.metricName === 'Traffic'
    )?.information?.[0]?.totalSessionCount;
  } catch (error) {
    results.dashboardApi.error = error.message;
  }

  // Test recordings API
  try {
    const recordings = await fetchSessionRecordings({ count: 1 });
    results.recordingsApi.success = true;
    results.recordingsApi.sampleUrl = recordings[0]?.playbackUrl;
  } catch (error) {
    results.recordingsApi.error = error.message;
  }

  return results;
}
