# Manga Veo Reader

Minimal scroll reader for manga PDFs with Veo 3.1 animation generation.

## Requirements

You need:
1. A Google account
2. A Gemini API key from https://aistudio.google.com/apikey
3. Enable "Generative Language API" in Google Cloud Console
4. Billing enabled (Veo uses paid credits)

## Setup

1. Install dependencies:
```bash
npm run install:all
```

2. Get your API key:
   - Go to https://aistudio.google.com/apikey
   - Create or select a project
   - Generate an API key
   - Enable billing at https://console.cloud.google.com/

3. Configure environment:
```bash
cp .env.example .env
# Add your GEMINI_API_KEY to .env
# Set USE_MOCK_MODE=false for real video generation
```

4. Run development servers:
```bash
npm run dev:all
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## Features

- PDF upload and rendering
- Vertical scroll manga reader
- Veo 3.1 video generation (8s, 720p/1080p/4K)
- Native audio generation
- Auto-play when in viewport
- Video caching with IndexedDB
- Smart prefetching
- Batch generation with progress
- Portrait (9:16) and landscape (16:9) support

## Pricing

Veo 3.1 pricing (as of Jan 2025):
- 720p: ~$0.10 per video
- 1080p: ~$0.20 per video
- 4K: ~$0.40 per video

Check latest pricing: https://ai.google.dev/pricing

## Troubleshooting

**"PERMISSION_DENIED" or "API not enabled":**
- Go to https://console.cloud.google.com/apis/library
- Search "Generative Language API"
- Click "Enable"

**"Billing not enabled":**
- Go to https://console.cloud.google.com/billing
- Add a payment method

**Still having issues?**
- Verify your API key at https://aistudio.google.com/apikey
- Check your project has billing enabled
- Ensure you're not hitting quota limits
