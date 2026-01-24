import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { parseCookies, checkCookieExpiry } from './cookie-utils.js';

// Re-export cookie utilities for convenience
export { parseCookies, checkCookieExpiry };

/**
 * Connect to Browserless.io and return a browser instance
 * @param {Object} options - Connection options
 * @param {boolean} options.record - Enable video recording
 * @returns {Promise<Browser>} Puppeteer browser instance
 */
export async function connectToBrowserless({ record = false } = {}) {
  let browserWSEndpoint = `wss://production-sfo.browserless.io?token=${config.browserless.apiKey}`;

  if (record) {
    // Add recording parameters for screencast
    browserWSEndpoint += '&headless=false&record=true';
  }

  const browser = await puppeteer.connect({
    browserWSEndpoint,
    protocolTimeout: 120000, // 2 minute timeout for CDP commands
  });

  return browser;
}

/**
 * Take a screenshot of a URL using Browserless REST API
 * @param {string} url - URL to screenshot
 * @param {Object} options - Screenshot options
 * @returns {Promise<Buffer>} Screenshot buffer
 */
export async function takeScreenshot(url, options = {}) {
  const apiUrl = `${config.browserless.endpoint}/screenshot?token=${config.browserless.apiKey}`;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      options: {
        fullPage: false,
        type: 'png',
        ...options,
      },
      gotoOptions: {
        waitUntil: 'networkidle2',
        timeout: 30000,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Browserless screenshot error (${response.status}): ${error}`);
  }

  return response.arrayBuffer();
}

/**
 * Record a Clarity session playback using Browserless screencast
 * Uses WebSocket connection with record=true and CDP commands
 *
 * IMPORTANT: Requires valid Clarity session cookies for authentication.
 * Export cookies from your browser while logged into Clarity.
 *
 * @param {string} clarityUrl - Clarity player URL
 * @param {number} durationMs - Expected recording duration in milliseconds
 * @param {Object} options - Recording options
 * @param {string|Array} options.clarityCookies - REQUIRED: Clarity session cookies
 * @returns {Promise<Buffer>} WebM video buffer
 */
export async function recordClaritySession(clarityUrl, durationMs, options = {}) {
  const {
    width = 1920,
    height = 1080,
    maxDurationMs = config.processing.recordingTimeoutMinutes * 60 * 1000,
    minDurationMs = 20000, // Minimum 20 seconds for page load + recording
    clarityCookies = null,
  } = options;

  // Validate cookies are provided
  if (!clarityCookies) {
    throw new Error(
      'clarityCookies is REQUIRED. Export cookies from your browser while logged into Clarity using EditThisCookie or similar extension.'
    );
  }

  // Parse and check cookie expiry
  const cookies = parseCookies(clarityCookies);
  const expiryInfo = checkCookieExpiry(cookies);

  if (!expiryInfo.valid && expiryInfo.error) {
    console.log(`  ⚠️ Cookie warning: ${expiryInfo.error}`);
  }

  if (expiryInfo.expired) {
    throw new Error(
      `Cookies have expired (expired ${Math.abs(expiryInfo.daysRemaining)} days ago). Please export fresh cookies from Clarity.`
    );
  }

  if (expiryInfo.daysRemaining !== null && expiryInfo.daysRemaining <= 3) {
    console.log(`  ⚠️ WARNING: Cookies expire in ${expiryInfo.daysRemaining} days (${expiryInfo.expiresAtFormatted})`);
  }

  // Connect with recording enabled
  const browser = await connectToBrowserless({ record: true });

  let page;
  let client;

  try {
    page = await browser.newPage();

    // Create CDP session for recording control BEFORE setViewport
    client = await page.target().createCDPSession();

    // Now set viewport
    await page.setViewport({ width, height });

    // Set authentication cookies
    console.log('  Setting authentication cookies...');

    // Filter for Clarity/Microsoft relevant cookies
    const relevantCookies = cookies.filter(
      (c) =>
        c.domain.includes('microsoft') ||
        c.domain.includes('clarity') ||
        c.domain.includes('live.com') ||
        c.domain.includes('microsoftonline')
    );

    if (relevantCookies.length > 0) {
      await page.setCookie(...relevantCookies);
      console.log(`  Set ${relevantCookies.length} authentication cookies`);
    } else {
      // Set all cookies if no Microsoft ones found
      await page.setCookie(...cookies);
      console.log(`  Set ${cookies.length} cookies`);
    }

    // Navigate to Clarity recording
    console.log('  Navigating to Clarity player...');
    await page.goto(clarityUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    // Check if we hit a login page
    const pageState = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      return {
        isLoginPage:
          bodyText.includes('sign back in') ||
          bodyText.includes('Sign in to Microsoft') ||
          bodyText.includes('Welcome back!') ||
          bodyText.includes('Sign in to Facebook') ||
          bodyText.includes('Sign in to Google'),
        hasPlayer:
          !!document.querySelector('canvas') ||
          !!document.querySelector('[class*="playback"]') ||
          !!document.querySelector('[class*="player-container"]'),
        title: document.title,
      };
    });

    if (pageState.isLoginPage) {
      // Take debug screenshot
      const debugScreenshot = await page.screenshot();
      const fs = await import('fs');
      fs.writeFileSync('clarity-auth-failed.png', debugScreenshot);

      throw new Error(
        'Clarity authentication failed - login page detected. Your cookies may have expired or are invalid. ' +
          'Please export fresh cookies from Clarity. Debug screenshot saved to clarity-auth-failed.png'
      );
    }

    // Wait for player to load - use multiple possible selectors
    console.log('  Waiting for player to load...');
    const playerSelectors = [
      'canvas',
      '[class*="player"]',
      '[class*="playback"]',
      '[class*="Player"]',
      '[class*="timeline"]',
      '[class*="Timeline"]',
      'iframe[src*="clarity"]',
      '[data-testid*="player"]',
    ];

    await page
      .waitForSelector(playerSelectors.join(', '), {
        timeout: 30000,
      })
      .catch(() => {
        console.log('  Player selector not found, checking page state...');
      });

    // Verify player loaded - check for various indicators
    const playerState = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const player = document.querySelector('[class*="player-container"], [class*="Player"], [class*="player"]');
      const timeline = document.querySelector('[class*="timeline"], [class*="Timeline"], [class*="progress"]');
      const iframe = document.querySelector('iframe');
      const videoContainer = document.querySelector('[class*="recording"], [class*="session"], [class*="playback"]');
      const pageTitle = document.title || '';
      const bodyText = document.body?.innerText || '';

      // Check if we're on a Clarity recording page (not login/error)
      const isRecordingPage = pageTitle.includes('Clarity') ||
                              bodyText.includes('recording') ||
                              bodyText.includes('session') ||
                              !!timeline ||
                              !!videoContainer;

      return {
        hasCanvas: !!canvas,
        canvasSize: canvas ? { width: canvas.width, height: canvas.height } : null,
        hasPlayer: !!player,
        hasTimeline: !!timeline,
        hasIframe: !!iframe,
        hasVideoContainer: !!videoContainer,
        isRecordingPage,
        pageTitle,
      };
    });

    // More lenient check - if we have timeline or any player indicator, proceed
    const hasValidPlayer = playerState.hasCanvas ||
                          playerState.hasPlayer ||
                          playerState.hasTimeline ||
                          playerState.hasVideoContainer ||
                          playerState.isRecordingPage;

    if (!hasValidPlayer) {
      // Take debug screenshot
      const debugScreenshot = await page.screenshot();
      const fs = await import('fs');
      fs.writeFileSync('clarity-load-error.png', debugScreenshot);
      throw new Error(
        'Clarity player did not load. Debug screenshot saved to clarity-load-error.png. ' +
          'This usually means authentication failed or the recording was deleted.'
      );
    }

    console.log(`  Player loaded: canvas=${playerState.hasCanvas}, timeline=${playerState.hasTimeline}, title="${playerState.pageTitle}"`);

    // Additional wait for player initialization
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Click play button if needed
    await page.evaluate(() => {
      const playSelectors = [
        'button[aria-label*="Play"]',
        'button[title*="Play"]',
        '[class*="play-button"]',
        '[class*="PlayButton"]',
        '[data-testid*="play"]',
      ];

      for (const selector of playSelectors) {
        const btn = document.querySelector(selector);
        if (btn) {
          btn.click();
          return true;
        }
      }

      // Try spacebar as fallback
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
      return false;
    });

    // Wait a moment for playback to start
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Start recording using Browserless CDP command
    console.log('  Starting screen recording...');
    await client.send('Browserless.startRecording');

    // Calculate recording duration with buffer - ensure minimum duration for short recordings
    const recordDuration = Math.min(
      Math.max(durationMs + 15000, minDurationMs), // At least minDuration, or duration + 15s buffer
      maxDurationMs
    );
    console.log(`  Recording for ${Math.ceil(recordDuration / 1000)} seconds...`);

    // Wait for recording duration
    await new Promise((resolve) => setTimeout(resolve, recordDuration));

    // Stop recording and get video
    console.log('  Stopping recording...');
    const response = await client.send('Browserless.stopRecording');

    await browser.close();

    // The response contains video data in Latin-1 encoding
    // Convert to buffer - response.value contains the binary data
    const videoData = response.value;
    return Buffer.from(videoData, 'latin1');
  } catch (error) {
    try {
      await browser.close();
    } catch (closeError) {
      // Ignore close errors
    }
    throw error;
  }
}

/**
 * Test Browserless connection
 * @returns {Promise<Object>} Test results
 */
export async function testConnection() {
  const results = {
    websocket: { success: false, error: null },
    restApi: { success: false, error: null },
  };

  // Test WebSocket connection
  try {
    const browser = await connectToBrowserless();
    results.websocket.success = true;
    await browser.close();
  } catch (error) {
    results.websocket.error = error.message;
  }

  // Test REST API (scrape)
  try {
    const response = await fetch(`${config.browserless.endpoint}/scrape?token=${config.browserless.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com',
        elements: [{ selector: 'h1' }],
      }),
    });

    if (response.ok) {
      results.restApi.success = true;
      const data = await response.json();
      results.restApi.sampleData = data;
    } else {
      results.restApi.error = await response.text();
    }
  } catch (error) {
    results.restApi.error = error.message;
  }

  return results;
}
