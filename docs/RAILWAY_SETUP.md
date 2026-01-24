# Railway Deployment Setup

Deploy your Clarity Recording Automation to Railway for a persistent, always-on API endpoint.

## Prerequisites

- GitHub account
- Railway account (free tier available)
- Your existing credentials (Browserless API key, Clarity API token, etc.)

## Step 1: Create Railway Account

1. Go to [railway.app](https://railway.app)
2. Click **Login** → **Login with GitHub**
3. Authorize Railway to access your GitHub

## Step 2: Push to GitHub

Your project needs to be in a GitHub repository:

```bash
# If not already a git repo
git init
git add .
git commit -m "Initial commit"

# Create repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/clarity-automation.git
git push -u origin main
```

## Step 3: Create Railway Project

1. Go to [Railway Dashboard](https://railway.app/dashboard)
2. Click **New Project**
3. Select **Deploy from GitHub repo**
4. Find and select your `clarity-automation` repository
5. Railway will auto-detect it's a Node.js project

## Step 4: Configure Environment Variables

In your Railway project:

1. Click on your service
2. Go to **Variables** tab
3. Add the following variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `CLARITY_PROJECT_ID` | Yes | Your Clarity project ID |
| `CLARITY_API_TOKEN` | Yes | Your Clarity API token |
| `BROWSERLESS_API_KEY` | Yes | Your Browserless.io API key |
| `BROWSERLESS_ENDPOINT` | No | Default: `https://production-sfo.browserless.io` |
| `MAX_CONCURRENT_RECORDINGS` | No | Default: `2` (match your Browserless plan) |
| `GOOGLE_CLIENT_ID` | No | For Google Drive uploads |
| `GOOGLE_CLIENT_SECRET` | No | For Google Drive uploads |
| `GOOGLE_DRIVE_FOLDER_ID` | No | Target folder for uploads |
| `SLACK_WEBHOOK_URL` | No | For cookie expiry notifications |

**Note:** Railway automatically sets `PORT` - you don't need to configure it.

## Step 5: Deploy

1. Railway will automatically deploy when you push to GitHub
2. Or click **Deploy** in the Railway dashboard

## Step 6: Get Your Public URL

1. Go to **Settings** tab in your Railway service
2. Under **Networking**, click **Generate Domain**
3. Your API will be available at: `https://your-app.up.railway.app`

## Testing Your Deployment

```bash
# Health check
curl https://your-app.up.railway.app/health

# Capture single recording
curl -X POST https://your-app.up.railway.app/capture \
  -H "Content-Type: application/json" \
  -d '{
    "clarityCookies": [...your exported cookies...],
    "uploadToGdrive": false
  }'

# Batch capture with parallel processing
curl -X POST https://your-app.up.railway.app/batch \
  -H "Content-Type: application/json" \
  -d '{
    "count": 4,
    "maxConcurrent": 2,
    "clarityCookies": [...your exported cookies...],
    "uploadToGdrive": false
  }'
```

## Using with n8n

In your n8n workflows, update the HTTP Request nodes:

```
URL: https://your-app.up.railway.app/batch
Method: POST
Body:
{
  "count": 10,
  "maxConcurrent": 2,
  "clarityCookies": {{ $json.cookies }},
  "uploadToGdrive": true
}
```

## Railway Free Tier Limits

| Resource | Free Tier Limit |
|----------|-----------------|
| Execution Hours | 500 hours/month |
| Memory | 512 MB |
| Storage | 1 GB |
| Bandwidth | 100 GB |

**Tips for staying within limits:**
- The server auto-sleeps when idle (no hours consumed)
- Recording capture uses most memory during browser sessions
- With 2 concurrent sessions, stay under 512 MB total

## Monitoring & Logs

1. Go to your Railway service
2. Click **Deployments** to see deployment history
3. Click **Logs** to view real-time logs

## Troubleshooting

### "Application failed to respond"
- Check logs for startup errors
- Verify all required environment variables are set

### "Out of memory"
- Reduce `MAX_CONCURRENT_RECORDINGS` to 1
- Recording capture is memory-intensive

### "Build failed"
- Ensure `package.json` has correct dependencies
- Check `railway.json` configuration

### Cookies not working
- Cookies must be passed in each request
- Cookies cannot be stored as environment variables (too large, contain special chars)

## Updating Your Deployment

Simply push to GitHub - Railway will auto-deploy:

```bash
git add .
git commit -m "Update feature"
git push origin main
```

## Custom Domain (Optional)

1. Go to **Settings** → **Networking**
2. Click **Add Custom Domain**
3. Enter your domain (e.g., `api.yourdomain.com`)
4. Add the CNAME record to your DNS provider
