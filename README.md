# Sonus Backend

A high-performance Node.js middleware for YouTube metadata and audio stream extraction.

## Features
- **YouTube Search**: Fast searching with configurable limits.
- **Metadata Extraction**: Detailed info including title, channel, duration, and high-res thumbnails.
- **Audio Streaming**: Direct extraction of `bestaudio` stream URLs.
- **Optimized Performance**: In-memory caching and request deduplication.
- **Render-Ready**: Optimized for deployment on Render.com.

## Prerequisites
- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (automatically downloaded via build script)

## Installation

```bash
git clone https://github.com/your-repo/sonus-backend.git
cd sonus-backend
npm install
npm run build
```

The `npm run build` script will automatically download the correct `yt-dlp` binary for your platform.

## Configuration
Create a `.env` file in the root:
```env
PORT=3000
ALLOWED_ORIGINS=http://localhost:5173,https://your-frontend.com
COOKIES_FILE_PATH=./cookies.txt
```

## API Endpoints

### Search
`GET /api/search?q=query&limit=20`
Returns an array of video results.

### Video Info
`GET /api/info/:videoId`
Returns detailed metadata for a video.

### Stream URL
`GET /api/stream/:videoId`
Returns a direct audio stream URL. These URLs are cached for 4 hours.

## Authentication
To avoid YouTube rate limiting or access restricted content, place a Netscape-format `cookies.txt` file in the project root.

## License
ISC
