const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const port = Number(process.env.PORT || 3002);
const publicDir = path.join(__dirname, 'public');
const splatsDir = path.resolve(process.env.EMS_SPATIAL_ASSETS_DIR || process.env.SPLATS_DIR || 'fixtures');
const certificatePath = process.env.EMS_HTTPS_CERT;
const privateKeyPath = process.env.EMS_HTTPS_KEY;

const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.ply': 'application/octet-stream',
    '.sog': 'application/octet-stream',
    '.splatseq': 'application/octet-stream',
    '.splatstream': 'application/octet-stream',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
};

const resolveInside = (root, requestPath) => {
    const target = path.resolve(root, requestPath);
    const relative = path.relative(path.resolve(root), target);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        return target;
    }
    return null;
};

const handler = (request, response) => {
    response.setHeader('Permissions-Policy', 'xr-spatial-tracking=(self)');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
    response.setHeader('Timing-Allow-Origin', '*');

    if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
    }

    let requestPath;
    try {
        requestPath = decodeURIComponent((request.url || '/').split('?')[0]);
    } catch {
        response.writeHead(400);
        response.end('Bad Request');
        return;
    }

    requestPath = requestPath === '/' ? 'index.html' : requestPath.replace(/^[/\\]+/, '');
    const isSplatRequest = requestPath.startsWith('splats/');
    response.setHeader(
        'Cache-Control',
        isSplatRequest ? 'private, max-age=3600, immutable' : 'no-store'
    );
    if (isSplatRequest) requestPath = requestPath.substring('splats/'.length);
    const filePath = resolveInside(isSplatRequest ? splatsDir : publicDir, requestPath);
    if (!filePath) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
    }

    fs.stat(filePath, (error, stats) => {
        if (error) {
            response.writeHead(error.code === 'ENOENT' ? 404 : 500);
            response.end(error.code === 'ENOENT' ? 'Not Found' : 'Server Error');
            return;
        }
        if (!stats.isFile()) {
            response.writeHead(404);
            response.end('Not Found');
            return;
        }

        const size = stats.size;
        const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        const range = request.headers.range;
        let start = 0;
        let end = Math.max(0, size - 1);
        let partial = false;
        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
            if (!match || (!match[1] && !match[2])) {
                response.writeHead(416, { 'Content-Range': `bytes */${size}` });
                response.end();
                return;
            }
            if (!match[1]) {
                const suffixLength = Number(match[2]);
                start = Math.max(0, size - suffixLength);
            } else {
                start = Number(match[1]);
            }
            end = match[2] && match[1] ? Number(match[2]) : size - 1;
            end = Math.min(end, size - 1);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
                response.writeHead(416, { 'Content-Range': `bytes */${size}` });
                response.end();
                return;
            }
            partial = true;
        }

        const headers = {
            'Accept-Ranges': 'bytes',
            'Content-Type': contentType,
            'Content-Length': String(size === 0 ? 0 : end - start + 1),
            'ETag': `"${size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`,
            'Last-Modified': stats.mtime.toUTCString(),
            ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
        };
        response.writeHead(partial ? 206 : 200, headers);
        if (request.method === 'HEAD' || size === 0) {
            response.end();
            return;
        }
        const stream = fs.createReadStream(filePath, {
            start,
            end,
            highWaterMark: 1024 * 1024
        });
        stream.on('error', () => response.destroy());
        stream.pipe(response);
    });
};

const useHttps = certificatePath && privateKeyPath
    && fs.existsSync(certificatePath) && fs.existsSync(privateKeyPath);
const server = useHttps
    ? https.createServer({
        cert: fs.readFileSync(certificatePath),
        key: fs.readFileSync(privateKeyPath)
    }, handler)
    : http.createServer(handler);

server.listen(port, '0.0.0.0', () => {
    const protocol = useHttps ? 'https' : 'http';
    console.log(`NextPlayer listening on ${protocol}://localhost:${port}/`);
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address.family === 'IPv4' && !address.internal) {
                console.log(`LAN: ${protocol}://${address.address}:${port}/`);
            }
        }
    }
    if (!useHttps) {
        console.log('WebXR on a LAN/Quest client requires HTTPS. Set EMS_HTTPS_CERT and EMS_HTTPS_KEY or use the same-origin HTTPS deployment.');
    }
});
