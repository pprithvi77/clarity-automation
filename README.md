# Clarity Recording Automation

Automatically capture Microsoft Clarity session recordings as video files using headless browser technology.

## Features

- **Job-Level Queue** - Multiple requests are queued; only ONE job runs at a time
- **Dedicated Folders** - Each job gets its own folder (e.g., `recordings/job_20250123_143022/`)
- **Webhook Callbacks** - Get notified when job completes with folder path
- **Parallel Processing** - Within a job, recordings process in parallel (up to your Browserless limit)
- **Railway Deployment** - Deploy as a cloud API endpoint
- **Google Drive Upload** - Automatically organize by date
- **Cookie Expiry Monitoring** - Slack notifications when cookies expire

## How the Queue Works

```
Person A triggers job (5 recordings)  → Job A starts processing
Person B triggers job (3 recordings)  → Job B queued (waits)
Person C triggers job (4 recordings)  → Job C queued (waits)

Job A completes → Webhook sent to Person A
Job B starts    → Person B's job now processing
Job B completes → Webhook sent to Person B
Job C starts    → etc.
```

Each job:
1. Gets a unique ID (e.g., `job_20250123_143022_001`)
2. Gets its own folder (all recordings saved there)
3. Runs to completion before next job starts
4. Sends webhook with results when done

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Export Clarity Cookies

1. Install [EditThisCookie](https://chrome.google.com/webstore/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg)
2. Log into [Microsoft Clarity](https://clarity.microsoft.com)
3. Click EditThisCookie icon → Export
4. Save as `clarity-cookies.json`

### 4. Start the Server

```bash
npm run server
```

### 5. Make API Requests

```bash
# Queue a job
curl -X POST http://localhost:3001/batch \
  -H "Content-Type: application/json" \
  -d '{
    "count": 5,
    "maxConcurrent": 2,
    "webhookUrl": "https://your-webhook.com/callback",
    "clarityCookies": [...your cookies...]
  }'

# Check queue status
curl http://localhost:3001/queue

# Check specific job
curl http://localhost:3001/queue/job/job_20250123_143022_001
```

## API Endpoints

### POST /batch - Queue a Job

```json
{
  "count": 10,
  "maxConcurrent": 2,
  "uploadToGdrive": false,
  "webhookUrl": "https://your-endpoint.com/callback",
  "metadata": { "customer": "Acme Corp" },
  "clarityCookies": [...]
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "job_20250123_143022_001",
  "folder": "./recordings/job_20250123_143022_001",
  "total": 10,
  "completed": 9,
  "failed": 1,
  "results": [...]
}
```

### Webhook Payload (sent on completion)

```json
{
  "event": "job_completed",
  "jobId": "job_20250123_143022_001",
  "status": "completed",
  "folder": "./recordings/job_20250123_143022_001",
  "recordingsTotal": 10,
  "recordingsCompleted": 9,
  "recordingsFailed": 1,
  "metadata": { "customer": "Acme Corp" },
  "results": [...]
}
```

### GET /queue - Queue Status

```json
{
  "currentJob": {
    "id": "job_20250123_143022_001",
    "status": "processing",
    "recordingsCompleted": 3,
    "recordingsTotal": 10
  },
  "queueLength": 2,
  "queuedJobs": [
    { "id": "job_20250123_143025_002", "recordingsTotal": 5 }
  ]
}
```

### GET /queue/job/:jobId - Job Details

Returns full job details including results.

## All Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check + queue status |
| `/queue` | GET | Queue statistics & active jobs |
| `/queue/job/:id` | GET | Get specific job status |
| `/capture` | POST | Capture single recording |
| `/batch` | POST | Queue batch job |
| `/recordings` | POST | Fetch recording URLs |
| `/cookies/check` | POST | Check cookie expiry |
| `/cookies/notify` | POST | Send Slack notification |

## File Structure

```
recordings/
├── job_20250123_143022_001/    # Job A's folder
│   ├── session_abc123.webm
│   ├── session_def456.webm
│   └── session_ghi789.webm
├── job_20250123_150000_002/    # Job B's folder
│   ├── session_xyz111.webm
│   └── session_xyz222.webm
└── job_20250123_160000_003/    # Job C's folder
    └── ...
```

## Railway Deployment

See `docs/RAILWAY_SETUP.md` for detailed instructions.

Quick steps:
1. Push to GitHub
2. Connect to Railway
3. Set environment variables
4. Get public URL

## Requirements

- Node.js 18+
- Browserless.io account (Starter plan = 2 concurrent)
- Microsoft Clarity account with API access
- Google Cloud project (optional, for Drive uploads)
