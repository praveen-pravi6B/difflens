# Deploying Difflens to Render.com

## Overview
Difflens can be deployed to [Render.com](https://render.com) - a free platform that supports Node.js applications.

## Prerequisites
- GitHub account
- Render.com account (free tier available)
- Difflens repo: `https://github.com/praveen-pravi6B/difflens`

## Step 1: Prepare the Repository

Ensure your repository has the following:
- `server.js` - Express server
- `package.json` with start script
- `public/` folder with static files
- `.github/workflows/` CI workflows (optional)

## Step 2: Create Render Web Service

1. Go to [render.com/dashboard](https://render.com/dashboard) and sign in
2. Click **New Web Service**
3. Connect your GitHub account
4. Select your repository: `praveen-pravi6B/difflens`
5. Name your service: `difflens`
6. Set the **Environment**: Node
7. Set the **Build Command**: `npm install`
8. Set the **Start Command**: `node server.js`
9. Click **Create Web Service**

## Step 2: Configure Environment Variables

In the Render dashboard, go to **Environment** and add:

| Variable | Value | Description |
|----------|-------|-------------|
| `PORT` | `4173` | Default Difflens port |
| `HOST` | `127.0.0.1` | Server bind address |
| `NODE_ENV` | `production` | Production mode |

## Step 2: Chromium/Playwright Setup

Render's free tier doesn't include Playwright browsers. You have two options:

### Option A: Install on Startup (Recommended)
Add this to your `server.js` after the `app.listen` call:

```javascript
const { setupPlaywright } = require('./scripts/install-browser');
setupPlaywright().catch(console.error);
```

Or add to your `package.json` scripts:
```json
"scripts": {
  "postinstall": "node scripts/install-browser.js"
}
```

### Option 2: Docker Deployment
Use a Docker container with Playwright pre-installed (see Dockerfile below).

## Step 3: Configure Environment Variables

Add these to your Render dashboard:

```
PORT: 4173
HOST: 127.0.0.1
NODE_ENV: production
```

## Step 4: Deploy

Click **Deploy Web Service**. Render will:
1. Install dependencies
2. Start the server
3. Make it available at `https://difflens-xxx.render.com`

## Step 5: Verify Deployment

Visit your deployed URL and test:
- Compare pages functionality
- Live mode (if enabled)
- Basic Auth (if configured)
- Smoke test (if enabled)

## Docker Deployment (Alternative)

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY . .

RUN npm install
RUN npx playwright install --headless

EXPOSE 4173
CMD ["node", "server.js"]
```

Create a `fly.toml`:

```toml
[build]
  publish = "dist"
  base_image = "node:20"

[env]
PORT = "4173"
HOST = "127.0.0.1"

[services]
  http_service = {
    internal_port = 4173
    protocol = "http"
  }
```

## Render vs Fly.io Comparison

| Feature | Render | Fly.io |
|---------|--------|--------|
| **Free tier** | 750 hours/month | 300 hours/month |
| **Chromium support** | Requires setup | Better support |
| **Static hosting** | Yes | Yes |
| **Auto-deploy** | Yes | Yes |
| **Dedicated IP** | No | Yes (paid) |

## Troubleshooting

### Common Issues

1. **Chromium not found**
   - Add `postinstall` script to `package.json`
   - Use Docker deployment

2. **Memory limits**
   - Render free tier: 512MB
   - Consider Fly.io for more memory

3. **Favicon/favicon not loading**
   - Ensure `public/logo.png` exists
   - Check `/logo.png` route in `public/index.html`

4. **Live mode not working**
   - Ensure `sandbox` attribute is handled
   - Check `X-Frame-Options` headers

### Common Issues and Solutions

| Problem | Solution |
|----------|----------|
| **Chromium not found** | Add `postinstall` script or use Docker |
| **Favicon not showing** | Ensure `public/logo.png` exists and `/logo.svg` route works |
| **Live mode fails** | Check iframe sandbox headers |
| **Auth not working** | Verify per-origin config in server.js |
| **Memory issues** | Consider Fly.io for more resources |

## Next Steps

1. Deploy to Render using the guide above
2. Test all functionality (comparison, live mode, auth)
3. Set up branch protection on GitHub
4. Add monitoring/alerts if needed
5. Consider adding a domain name

---
*Last updated: 2024*

---
*For support, visit: https://github.com/praveen-pravi6B/difflens/discussions*
