/**
 * Cookie utilities for Clarity authentication
 * Handles parsing, validation, and expiry checking
 */

/**
 * Parse cookies from various formats (JSON array, Netscape, header string)
 * @param {string|Array} cookieInput - Cookies in various formats
 * @returns {Array} Array of normalized cookie objects
 */
export function parseCookies(cookieInput) {
  if (!cookieInput) return [];

  // If already an array of cookie objects
  if (Array.isArray(cookieInput)) {
    return cookieInput.map(normalizeCookie);
  }

  // If a JSON string
  if (typeof cookieInput === 'string' && cookieInput.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(cookieInput);
      return parsed.map(normalizeCookie);
    } catch (e) {
      // Not valid JSON, try other formats
    }
  }

  // If Netscape format (from cookie export)
  if (typeof cookieInput === 'string' && cookieInput.includes('\t')) {
    return parseNetscapeCookies(cookieInput);
  }

  // If cookie header string format (name=value; name2=value2)
  if (typeof cookieInput === 'string') {
    return parseCookieHeaderString(cookieInput);
  }

  return [];
}

/**
 * Normalize a cookie object to Puppeteer format
 */
function normalizeCookie(cookie) {
  // Handle sameSite conversion
  let sameSite = 'Lax';
  if (cookie.sameSite === 'no_restriction' || cookie.sameSite === 'None') {
    sameSite = 'None';
  } else if (cookie.sameSite === 'lax' || cookie.sameSite === 'Lax') {
    sameSite = 'Lax';
  } else if (cookie.sameSite === 'strict' || cookie.sameSite === 'Strict') {
    sameSite = 'Strict';
  }

  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || '.microsoft.com',
    path: cookie.path || '/',
    expires: cookie.expires || cookie.expirationDate || -1,
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? true,
    sameSite,
  };
}

/**
 * Parse Netscape cookie format
 */
function parseNetscapeCookies(cookieString) {
  const cookies = [];
  const lines = cookieString.split('\n');

  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;

    const parts = line.split('\t');
    if (parts.length >= 7) {
      cookies.push({
        domain: parts[0],
        path: parts[2],
        secure: parts[3] === 'TRUE',
        expires: parseInt(parts[4]) || -1,
        name: parts[5],
        value: parts[6],
        httpOnly: false,
        sameSite: 'Lax',
      });
    }
  }

  return cookies;
}

/**
 * Parse cookie header string format
 */
function parseCookieHeaderString(cookieString) {
  const cookies = [];
  const pairs = cookieString.split(';');

  for (const pair of pairs) {
    const [name, ...valueParts] = pair.trim().split('=');
    if (name && valueParts.length > 0) {
      cookies.push({
        name: name.trim(),
        value: valueParts.join('=').trim(),
        domain: '.microsoft.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      });
    }
  }

  return cookies;
}

/**
 * Find the authentication cookie and check its expiry
 * @param {Array} cookies - Array of cookie objects
 * @returns {Object} Expiry information
 */
export function checkCookieExpiry(cookies) {
  const parsedCookies = Array.isArray(cookies) ? cookies : parseCookies(cookies);

  // Key authentication cookies to check
  const authCookieNames = ['aadprofile', 'ESTSAUTHPERSISTENT', 'ESTSAUTH', 'MSPAuth'];

  let earliestExpiry = null;
  let authCookieFound = null;

  for (const cookie of parsedCookies) {
    if (authCookieNames.includes(cookie.name)) {
      const expiry = cookie.expires || cookie.expirationDate;

      if (expiry && expiry > 0) {
        // Convert to milliseconds if in seconds
        const expiryMs = expiry > 9999999999 ? expiry : expiry * 1000;

        if (!earliestExpiry || expiryMs < earliestExpiry) {
          earliestExpiry = expiryMs;
          authCookieFound = cookie.name;
        }
      }
    }
  }

  if (!earliestExpiry) {
    return {
      valid: false,
      error: 'No authentication cookie found (aadprofile, ESTSAUTHPERSISTENT, etc.)',
      authCookie: null,
      expiresAt: null,
      daysRemaining: null,
    };
  }

  const now = Date.now();
  const daysRemaining = Math.floor((earliestExpiry - now) / (1000 * 60 * 60 * 24));
  const expiresAt = new Date(earliestExpiry);

  // Determine warning level based on days remaining
  let warningLevel;
  if (earliestExpiry <= now) {
    warningLevel = 'expired';
  } else if (daysRemaining <= 3) {
    warningLevel = 'critical';
  } else if (daysRemaining <= 7) {
    warningLevel = 'warning';
  } else {
    warningLevel = 'ok';
  }

  return {
    valid: earliestExpiry > now,
    expired: earliestExpiry <= now,
    authCookie: authCookieFound,
    expiresAt: expiresAt.toISOString(),
    expiresAtFormatted: expiresAt.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    daysRemaining,
    hoursRemaining: Math.floor((earliestExpiry - now) / (1000 * 60 * 60)),
    warningLevel,
  };
}

/**
 * Send Slack notification about cookie expiry
 * @param {string} webhookUrl - Slack webhook URL
 * @param {Object} expiryInfo - Cookie expiry information
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Notification result
 */
export async function sendSlackExpiryNotification(webhookUrl, expiryInfo, options = {}) {
  if (!webhookUrl) {
    return { success: false, error: 'No Slack webhook URL provided' };
  }

  const { projectName = 'Clarity', customerName = '' } = options;

  // Determine emoji and color based on warning level
  const config = {
    critical: { emoji: '🚨', color: '#dc3545', title: 'CRITICAL: Cookies Expiring Soon!' },
    warning: { emoji: '⚠️', color: '#ffc107', title: 'Warning: Cookies Expiring' },
    ok: { emoji: '✅', color: '#28a745', title: 'Cookie Status: OK' },
    expired: { emoji: '❌', color: '#dc3545', title: 'EXPIRED: Cookies Need Renewal!' },
  };

  const level = expiryInfo.expired ? 'expired' : expiryInfo.warningLevel;
  const { emoji, color, title } = config[level];

  const message = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Project:*\n${projectName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Customer:*\n${customerName || 'N/A'}`,
          },
          {
            type: 'mrkdwn',
            text: `*Auth Cookie:*\n${expiryInfo.authCookie || 'Not found'}`,
          },
          {
            type: 'mrkdwn',
            text: `*Days Remaining:*\n${expiryInfo.daysRemaining !== null ? expiryInfo.daysRemaining : 'Unknown'}`,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: expiryInfo.expired
            ? `*Status:* Cookies have EXPIRED. Recording capture will fail until cookies are renewed.`
            : `*Expires:* ${expiryInfo.expiresAtFormatted}`,
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: expiryInfo.daysRemaining <= 7
            ? '👉 *Action Required:* Please export fresh cookies from Clarity and update the configuration.'
            : '📝 No action needed at this time.',
        },
      },
    ],
    attachments: [
      {
        color,
        footer: `Clarity Recording Automation | ${new Date().toISOString()}`,
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Slack API error: ${errorText}` };
    }

    return { success: true, level, daysRemaining: expiryInfo.daysRemaining };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Check cookies and send notification if expiring soon
 * @param {Array} cookies - Cookie array
 * @param {string} slackWebhookUrl - Slack webhook URL
 * @param {Object} options - Options including thresholdDays
 * @returns {Promise<Object>} Check result
 */
export async function checkAndNotify(cookies, slackWebhookUrl, options = {}) {
  const { thresholdDays = 7, alwaysNotify = false } = options;

  const expiryInfo = checkCookieExpiry(cookies);

  // Determine if we should send notification
  const shouldNotify =
    alwaysNotify ||
    expiryInfo.expired ||
    (expiryInfo.daysRemaining !== null && expiryInfo.daysRemaining <= thresholdDays);

  let notificationResult = null;

  if (shouldNotify && slackWebhookUrl) {
    notificationResult = await sendSlackExpiryNotification(slackWebhookUrl, expiryInfo, options);
  }

  return {
    ...expiryInfo,
    notificationSent: notificationResult?.success || false,
    notificationError: notificationResult?.error || null,
  };
}
