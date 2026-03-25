const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const fs = require('fs');
const path = require('path');

// Cookie strategy: prefer cookies.txt file, then try browsers, then no-auth
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const getCookieArgs = () => {
    if (fs.existsSync(COOKIES_FILE)) {
        console.log('[yt-dlp] Using cookies.txt file');
        return ['--cookies', COOKIES_FILE];
    }
    // Browser fallback order - firefox doesn't lock its DB while open (unlike Chrome)
    const browser = process.env.YTDLP_BROWSER || 'firefox';
    console.log(`[yt-dlp] No cookies.txt found, trying browser: ${browser}`);
    return ['--cookies-from-browser', browser];
};

const COMMON_ARGS = [
    '--no-warnings',
    // Use Node.js to solve YouTube's JS signature challenge (required for audio formats)
    '--no-js-runtimes', '--js-runtimes', 'node',
    // Allow yt-dlp to download the EJS challenge solver script from GitHub
    '--remote-components', 'ejs:github',
];


// Helper to run yt-dlp commands
const runYtdlp = (args) => {
    return new Promise((resolve, reject) => {
        const process = spawn('yt-dlp', [...COMMON_ARGS, ...getCookieArgs(), ...args]);
        let stdout = '';
        let stderr = '';

        process.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        process.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        process.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(stderr || `Process exited with code ${code}`));
            }
        });
    });
};

// API: Search
app.get('/api/search', async (req, res) => {
    const { q, limit = 20 } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });

    try {
        const args = [
            `ytsearch${limit}:${q}`,
            '--print', '%(id)s|%(title)s|%(uploader)s|%(duration)s|%(thumbnail)s|%(view_count)s',
            '--flat-playlist',
            '--no-playlist',
        ];
        
        const output = await runYtdlp(args);
        const lines = output.trim().split('\n');
        const results = lines.map(line => {
            const [id, title, channel, duration, thumbnailUrl, viewCount] = line.split('|');
            if (!id) return null;
            return {
                id,
                title,
                channel,
                duration: parseInt(duration) || 0,
                thumbnailUrl,
                viewCount: parseInt(viewCount) || 0
            };
        }).filter(Boolean);

        res.json(results);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Failed to search YouTube', details: error.message });
    }
});

// API: Info
app.get('/api/info/:videoId', async (req, res) => {
    const { videoId } = req.params;
    try {
        const output = await runYtdlp([
            `https://www.youtube.com/watch?v=${videoId}`,
            '--print', '%(id)s|%(title)s|%(uploader)s|%(duration)s|%(thumbnail)s|%(description)s',
            '--no-playlist',
        ]);
        const [id, title, channel, duration, thumbnailUrl, ...descriptionParts] = output.trim().split('|');
        res.json({
            id,
            title,
            channel,
            duration: parseInt(duration) || 0,
            thumbnailUrl,
            description: descriptionParts.join('|')
        });
    } catch (error) {
        console.error('Info error:', error);
        res.status(500).json({ error: 'Failed to get video info', details: error.message });
    }
});

// In-memory URL cache: { videoId -> { url, expiresAt } }
const urlCache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (YouTube URLs are valid ~6h)

// In-flight deduplication: prevent multiple concurrent yt-dlp calls for same video
const inflight = new Map();

// API: Stream (Get Audio URL)
app.get('/api/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    try {
        // 1. Cache hit
        const cached = urlCache.get(videoId);
        if (cached && cached.expiresAt > Date.now()) {
            console.log(`[cache hit] ${videoId}`);
            return res.json({ url: cached.url });
        }

        // 2. Deduplicate: if a fetch is already in progress for this video, wait for it
        if (inflight.has(videoId)) {
            console.log(`[dedup] Waiting for in-flight request: ${videoId}`);
            const url = await inflight.get(videoId);
            return res.json({ url });
        }

        // 3. Fetch from yt-dlp
        const fetchPromise = runYtdlp([
            '-f', 'bestaudio/best',
            '--get-url',
            `https://www.youtube.com/watch?v=${videoId}`
        ]).then(output => output.trim());

        inflight.set(videoId, fetchPromise);

        const url = await fetchPromise;
        inflight.delete(videoId);

        urlCache.set(videoId, { url, expiresAt: Date.now() + CACHE_TTL_MS });
        res.json({ url });
    } catch (error) {
        inflight.delete(videoId);
        console.error('Stream error:', error);
        res.status(500).json({ error: 'Failed to get stream URL', details: error.message });
    }
});

// Health check
app.get('/api/health', async (req, res) => {
    try {
        const version = await runYtdlp(['--version']);
        res.json({ status: 'ok', ytdlpVersion: version.trim() });
    } catch (error) {
        res.status(500).json({ status: 'error', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
