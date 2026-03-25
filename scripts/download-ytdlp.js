const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const platform = os.platform();
const isWin = platform === 'win32';
const filename = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`;
const dest = path.join(__dirname, '..', filename);

console.log(`Downloading ${filename} for ${platform} to ${dest}...`);

const request = https.get(url, (res) => {
    if (res.statusCode === 302 || res.statusCode === 301) {
        // Handle redirect
        https.get(res.headers.location, (res2) => {
            const file = fs.createWriteStream(dest);
            res2.pipe(file);
            file.on('finish', () => {
                file.close();
                if (!isWin) {
                    fs.chmodSync(dest, '755');
                }
                console.log('Download complete.');
            });
        });
        return;
    }

    if (res.statusCode !== 200) {
        console.error(`Failed to download: ${res.statusCode}`);
        return;
    }

    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on('finish', () => {
        file.close();
        if (!isWin) {
            fs.chmodSync(dest, '755');
        }
        console.log('Download complete.');
    });
});

request.on('error', (err) => {
    console.error(`Error downloading: ${err.message}`);
});
