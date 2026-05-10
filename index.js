const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// On Render, bind to 0.0.0.0 is handled via listen(PORT), but CORS
// should whitelist your actual frontend origin in production.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : '*';

app.use(cors({
    origin: ALLOWED_ORIGINS,
    methods: ['GET'],
}));
app.use(express.json());

const fs = require('fs');
const path = require('path');

// On Render, __dirname is the repo root at /opt/render/project/src
// cookies.txt can be placed there or its path overridden via env var.
const COOKIES_FILE = process.env.COOKIES_FILE_PATH || path.join(__dirname, 'cookies.txt');

const getCookieArgs = () => {
    if (fs.existsSync(COOKIES_FILE)) {
        console.log('[yt-dlp] Using cookies.txt file');
        return ['--cookies', COOKIES_FILE];
    }
    // On Render there is no browser session — skip browser fallback entirely.
    // Without cookies, yt-dlp still works for most public videos.
    console.log('[yt-dlp] No cookies.txt found, proceeding without auth');
    return [];
};

// yt-dlp binary: Prioritize local binary from build script, then fallback to env var or PATH
const isWin = process.platform === 'win32';
const localBin = path.join(__dirname, isWin ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_BIN = fs.existsSync(localBin) 
    ? localBin 
    : (process.env.YTDLP_PATH || 'yt-dlp');

const COMMON_ARGS = [
    '--no-warnings',
    '--no-js-runtimes', '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
];

// Helper to run yt-dlp commands
const runYtdlp = (args) => {
    return new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_BIN, [...COMMON_ARGS, ...getCookieArgs(), ...args]);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('error', (err) => {
            // Catches ENOENT when yt-dlp binary isn't found
            reject(new Error(`Failed to start yt-dlp: ${err.message}. Make sure yt-dlp is installed.`));
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(stderr || `yt-dlp exited with code ${code}`));
            }
        });
    });
};

// API: Search
app.get('/api/search', async (req, res) => {
    const { q, limit = 20 } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });

    try {
        const safeLimit = Math.min(parseInt(limit) || 20, 50); // cap at 50
        const args = [
            `ytsearch${safeLimit}:${q}`,
            '--print', '%(id)s|%(title)s|%(uploader)s|%(duration)s|%(thumbnail)s|%(view_count)s',
            '--flat-playlist',
            '--no-playlist',
        ];

        const output = await runYtdlp(args);
        const results = output.trim().split('\n').map(line => {
            const [id, title, channel, duration, thumbnailUrl, viewCount] = line.split('|');
            if (!id) return null;
            return {
                id,
                title,
                channel,
                duration: parseInt(duration) || 0,
                thumbnailUrl,
                viewCount: parseInt(viewCount) || 0,
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
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'Invalid video ID' });
    }
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
            description: descriptionParts.join('|'),
        });
    } catch (error) {
        console.error('Info error:', error);
        res.status(500).json({ error: 'Failed to get video info', details: error.message });
    }
});

// In-memory URL cache: { videoId -> { url, expiresAt } }
const urlCache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Periodic cleanup to prevent unbounded memory growth on long-running instances
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of urlCache.entries()) {
        if (val.expiresAt <= now) urlCache.delete(key);
    }
}, 30 * 60 * 1000); // every 30 min

// In-flight deduplication
const inflight = new Map();

// API: Stream (Get Audio URL)
app.get('/api/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'Invalid video ID' });
    }
    try {
        // 1. Cache hit
        const cached = urlCache.get(videoId);
        if (cached && cached.expiresAt > Date.now()) {
            console.log(`[cache hit] ${videoId}`);
            return res.json({ url: cached.url });
        }

        // 2. Deduplicate concurrent requests for the same video
        if (inflight.has(videoId)) {
            console.log(`[dedup] Waiting for in-flight request: ${videoId}`);
            const url = await inflight.get(videoId);
            return res.json({ url });
        }

        // 3. Fetch from yt-dlp
        const fetchPromise = runYtdlp([
            '-f', 'bestaudio/best',
            '--get-url',
            `https://www.youtube.com/watch?v=${videoId}`,
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

// Health check — also verifies yt-dlp is installed and reachable
app.get('/api/health', async (req, res) => {
    try {
        const version = await runYtdlp(['--version']);
        res.json({ status: 'ok', ytdlpVersion: version.trim() });
    } catch (error) {
        res.status(500).json({ status: 'error', details: error.message });
    }
});

// Render sends SIGTERM before shutting down — exit cleanly
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
