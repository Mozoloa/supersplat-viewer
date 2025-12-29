/* eslint-disable */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SPLATS_DIR = 'G:\\AI\\Image\\Stable Diffusion\\Data\\Packages\\ComfyUI-ngty\\output';

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.woff': 'application/font-woff',
    '.ttf': 'application/font-ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'application/font-otf',
    '.wasm': 'application/wasm',
    '.ply': 'application/octet-stream'
};

const server = http.createServer((req, res) => {
    console.log(`request: ${req.url}`);

    // Handle Remote Logging
    if (req.url === '/api/log' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const log = JSON.parse(body);
                const type = log.type.toUpperCase();
                const color = type === 'ERROR' ? '\x1b[31m' : (type === 'WARN' ? '\x1b[33m' : '\x1b[36m');
                const reset = '\x1b[0m';
                console.log(`${color}[CLIENT ${type}]${reset}`, ...log.args);
            } catch (e) {
                console.error('Failed to parse log:', e);
            }
            res.writeHead(200);
            res.end();
        });
        return;
    }

    // Handle API requests
    if (req.url === '/api/splats') {
        fs.readdir(SPLATS_DIR, (err, files) => {
            if (err) {
                console.error('Error reading splats directory:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to read directory' }));
                return;
            }

            const plyFiles = files
                .filter(file => file.toLowerCase().endsWith('.ply'))
                .map(file => {
                    const filePath = path.join(SPLATS_DIR, file);
                    const stats = fs.statSync(filePath);
                    return {
                        name: file,
                        date: stats.mtime
                    };
                })
                .sort((a, b) => b.date - a.date); // Sort by date descending

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(plyFiles));
        });
        return;
    }

    // Handle Settings API
    if (req.url.startsWith('/api/settings')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const filename = url.searchParams.get('filename');

        if (!filename) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Filename required' }));
            return;
        }

        // Ensure filename doesn't contain path traversal
        const safeFilename = path.basename(filename);
        const settingsPath = path.join(SPLATS_DIR, safeFilename + '.json');

        if (req.method === 'GET') {
            if (fs.existsSync(settingsPath)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                fs.createReadStream(settingsPath).pipe(res);
            } else {
                // Try to load last settings if specific settings don't exist
                const lastSettingsPath = path.join(SPLATS_DIR, 'last_settings.json');
                if (fs.existsSync(lastSettingsPath)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    fs.createReadStream(lastSettingsPath).pipe(res);
                } else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Settings not found' }));
                }
            }
            return;
        }

        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', () => {
                // Save specific settings
                fs.writeFile(settingsPath, body, (err) => {
                    if (err) {
                        console.error('Error saving settings:', err);
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Failed to save settings' }));
                    } else {
                        // Also save as last_settings.json
                        const lastSettingsPath = path.join(SPLATS_DIR, 'last_settings.json');
                        fs.writeFile(lastSettingsPath, body, () => { });

                        res.writeHead(200);
                        res.end(JSON.stringify({ success: true }));
                    }
                });
            });
            return;
        }
    }

    // Handle splat file requests
    if (req.url.startsWith('/splats/')) {
        const urlPath = req.url.split('?')[0];
        const filename = decodeURIComponent(urlPath.substring(8));
        const filePath = path.join(SPLATS_DIR, filename);

        // Security check: ensure we don't escape the directory
        if (!filePath.startsWith(SPLATS_DIR)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        fs.stat(filePath, (err, stats) => {
            if (err) {
                res.writeHead(404);
                res.end('File not found');
                return;
            }

            const contentType = 'application/octet-stream';
            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': stats.size,
                'Access-Control-Allow-Origin': '*'
            });

            const readStream = fs.createReadStream(filePath);
            readStream.pipe(res);
        });
        return;
    }

    // Handle static files
    let requestPath = req.url.split('?')[0];
    if (requestPath === '/') {
        requestPath = '/index.html';
    }
    let filePath = path.join(PUBLIC_DIR, requestPath);
    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});
