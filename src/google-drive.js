import { google } from 'googleapis';
import { config } from './config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const TOKEN_PATH = path.join(process.cwd(), 'config', 'google-token.json');

/**
 * Get OAuth2 client for Google Drive API
 * @returns {Promise<OAuth2Client>} Authenticated OAuth2 client
 */
export async function getAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    config.googleDrive.clientId,
    config.googleDrive.clientSecret,
    'http://localhost:3000/oauth2callback'
  );

  // Check for existing token
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    oauth2Client.setCredentials(token);

    // Refresh token if expired
    if (token.expiry_date && token.expiry_date < Date.now()) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials));
    }

    return oauth2Client;
  }

  // No token exists, need to authorize
  throw new Error(
    'Google Drive not authorized. Run "npm run auth:google" to authenticate.'
  );
}

/**
 * Interactive authorization flow for Google Drive
 * @returns {Promise<OAuth2Client>} Authenticated OAuth2 client
 */
export async function authorizeInteractive() {
  const oauth2Client = new google.auth.OAuth2(
    config.googleDrive.clientId,
    config.googleDrive.clientSecret,
    'urn:ietf:wg:oauth:2.0:oob' // For desktop/CLI apps
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\n========================================');
  console.log('Google Drive Authorization Required');
  console.log('========================================\n');
  console.log('1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Authorize the application');
  console.log('3. Copy the authorization code and paste it below\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise((resolve) => {
    rl.question('Enter the authorization code: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Save token for future use
  const configDir = path.dirname(TOKEN_PATH);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console.log('\nToken saved to', TOKEN_PATH);

  return oauth2Client;
}

/**
 * Upload a file to Google Drive
 * @param {Buffer|string} fileContent - File content or path
 * @param {string} fileName - Name for the uploaded file
 * @param {string} mimeType - MIME type of the file
 * @param {string} parentFolderId - Parent folder ID (optional)
 * @returns {Promise<Object>} Upload result with file ID and web link
 */
export async function uploadFile(fileContent, fileName, mimeType, parentFolderId = null) {
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  const folderId = parentFolderId || config.googleDrive.folderId;

  // Create file metadata
  const fileMetadata = {
    name: fileName,
  };

  if (folderId) {
    fileMetadata.parents = [folderId];
  }

  // Prepare media body
  let media;
  if (typeof fileContent === 'string') {
    // It's a file path
    media = {
      mimeType,
      body: fs.createReadStream(fileContent),
    };
  } else {
    // It's a buffer
    const { Readable } = await import('stream');
    const stream = new Readable();
    stream.push(fileContent);
    stream.push(null);
    media = {
      mimeType,
      body: stream,
    };
  }

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, name, webViewLink, webContentLink',
  });

  return {
    fileId: response.data.id,
    fileName: response.data.name,
    webViewLink: response.data.webViewLink,
    downloadLink: response.data.webContentLink,
  };
}

/**
 * Create a folder in Google Drive
 * @param {string} folderName - Name of the folder
 * @param {string} parentFolderId - Parent folder ID (optional)
 * @returns {Promise<string>} Created folder ID
 */
export async function createFolder(folderName, parentFolderId = null) {
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  const fileMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  };

  if (parentFolderId || config.googleDrive.folderId) {
    fileMetadata.parents = [parentFolderId || config.googleDrive.folderId];
  }

  const response = await drive.files.create({
    requestBody: fileMetadata,
    fields: 'id',
  });

  return response.data.id;
}

/**
 * Get or create a date-based folder structure
 * @param {Date} date - Date for folder name
 * @returns {Promise<string>} Folder ID
 */
export async function getOrCreateDateFolder(date = new Date()) {
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  const folderName = date.toISOString().split('T')[0]; // YYYY-MM-DD
  const parentId = config.googleDrive.folderId;

  // Check if folder already exists
  const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder'${
    parentId ? ` and '${parentId}' in parents` : ''
  } and trashed=false`;

  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
  });

  if (response.data.files && response.data.files.length > 0) {
    return response.data.files[0].id;
  }

  // Create new folder
  return createFolder(folderName, parentId);
}

/**
 * Upload a recording to the appropriate date folder
 * @param {Buffer} videoBuffer - Video content
 * @param {string} sessionId - Clarity session ID
 * @param {Date} recordingDate - Date of the recording
 * @returns {Promise<Object>} Upload result
 */
export async function uploadRecording(videoBuffer, sessionId, recordingDate = new Date()) {
  const folderId = await getOrCreateDateFolder(recordingDate);
  // Browserless returns WebM format video
  const fileName = `${sessionId}.webm`;

  return uploadFile(videoBuffer, fileName, 'video/webm', folderId);
}

/**
 * Test Google Drive connection
 * @returns {Promise<Object>} Test results
 */
export async function testConnection() {
  const results = {
    authenticated: false,
    canList: false,
    error: null,
  };

  try {
    const auth = await getAuthClient();
    results.authenticated = true;

    const drive = google.drive({ version: 'v3', auth });
    const response = await drive.files.list({
      pageSize: 1,
      fields: 'files(id, name)',
    });

    results.canList = true;
    results.sampleFile = response.data.files?.[0]?.name;
  } catch (error) {
    results.error = error.message;
  }

  return results;
}
