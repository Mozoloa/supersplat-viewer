// Bounded, loopback-only benchmark of the actual NextPlayer loading path.
// Inputs are never captured or displayed. Requires Playwright through NODE_PATH.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

async function main() {
    const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const publicRoot = path.resolve(__dirname, '../public');
    const files = new Map(config.assets.flatMap((asset, index) => [
        [`/asset-${index}${path.extname(asset.file)}`, path.resolve(asset.file)],
        [`/asset-${index}.ems.json`, path.resolve(asset.manifest)]
    ]));
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const filename = files.get(pathname) || (pathname.startsWith('/asset-') ? null
            : path.join(publicRoot, pathname === '/' ? 'index.html' : pathname.slice(1)));
        if (!filename || (!files.has(pathname) && !filename.startsWith(publicRoot + path.sep)) || !fs.existsSync(filename)) {
            response.writeHead(404); response.end(); return;
        }
        const size = fs.statSync(filename).size;
        const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (start > end) { response.writeHead(416); response.end(); return; }
        const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
        response.writeHead(range ? 206 : 200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream',
            'Content-Length': end - start + 1, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
        fs.createReadStream(filename, { start, end }).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    const results = [];
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true,
            args: ['--enable-gpu', '--disable-software-rasterizer', '--disable-background-timer-throttling',
                '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
        for (const [index, asset] of config.assets.entries()) {
            const context = await browser.newContext({ viewport: { width: 3840, height: 1920 }, deviceScaleFactor: 1 });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error','warning'].includes(message.type())) errors.push(message.text()); });
            const url = `http://127.0.0.1:${server.address().port}/?backend=webgl2&content=${encodeURIComponent(`/asset-${index}${path.extname(asset.file)}`)}`;
            await page.goto(url);
            await page.waitForFunction(() => /Authored view ready|Legacy view ready|could not load/.test(document.querySelector('#headline').textContent), { timeout: 60000 });
            if ((await page.locator('#headline').textContent()).includes('could not load')) throw new Error(await page.locator('#notice').textContent());
            const measured = await page.evaluate(async () => {
                const { app } = await document.querySelector('pc-app').ready();
                const { entity: camera } = await document.querySelector('pc-entity[name="camera"]').ready();
                const { entity: content } = await document.querySelector('pc-entity[name="content-root"]').ready();
                const gl = app.graphicsDevice.gl;
                const debug = gl.getExtension('WEBGL_debug_renderer_info');
                const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
                if (/SwiftShader|llvmpipe|Microsoft Basic Render/i.test(renderer)) throw new Error(`Software rendering: ${renderer}`);
                const extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
                if (!extension) throw new Error('GPU timer queries unavailable.');
                const original = camera.getPosition().clone();
                const rotation = camera.getRotation().clone();
                const definition = await (await fetch(new URL(location.href).searchParams.get('content').replace(/\.[^.]+$/, '.ems.json'))).json();
                const pivot = definition.grabPivot || [0,0,-2];
                const right = camera.clone(); app.root.addChild(right);
                camera.camera.rect.set(0,0,.5,1); right.camera.rect.set(.5,0,.5,1);
                camera.camera.fov = right.camera.fov = 90;
                app.graphicsDevice.resizeCanvas(3840,1920);
                const scenarios = [];
                const waitFrames = count => new Promise(resolve => {
                    let done=0; const listener=()=>{ if (++done>=count) { app.off('frameend',listener);resolve(); } };
                    app.on('frameend',listener);
                });
                for (const elevation of [0,45,-35]) {
                    const theta=elevation*Math.PI/180;
                    const y=original.y-pivot[1], z=original.z-pivot[2];
                    const position=[original.x,pivot[1]+y*Math.cos(theta)+z*Math.sin(theta),pivot[2]+z*Math.cos(theta)-y*Math.sin(theta)];
                    camera.setPosition(...position);
                    if (elevation) camera.lookAt(...pivot); else camera.setRotation(rotation);
                    const axis=camera.right.clone().mulScalar(.032);
                    right.setPosition(camera.getPosition().clone().add(axis)); right.setRotation(camera.getRotation());
                    camera.setPosition(camera.getPosition().clone().sub(axis));
                    await waitFrames(40);
                    if(gl.drawingBufferWidth!==3840||gl.drawingBufferHeight!==1920) throw new Error('Stereo render resolution changed.');
                    const queries=[], values=[], cpu=[]; let query, started;
                    const before=()=>{
                        for(let i=queries.length-1;i>=0;i--) {
                            const q=queries[i];
                            if(gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)) {
                                if(!gl.getParameter(extension.GPU_DISJOINT_EXT)) values.push(gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);
                                gl.deleteQuery(q);queries.splice(i,1);
                            }
                        }
                        query=gl.createQuery();gl.beginQuery(extension.TIME_ELAPSED_EXT,query);started=performance.now();
                    };
                    const after=()=>{gl.endQuery(extension.TIME_ELAPSED_EXT);queries.push(query);cpu.push(performance.now()-started);};
                    // Include uploads and scene preparation as well as draw
                    // passes; timing only render would omit ordinary GS data work.
                    app.on('frameupdate',before);app.on('frameend',after);
                    await waitFrames(150);
                    app.off('frameupdate',before);app.off('frameend',after);
                    app.autoRender=false;gl.flush();
                    const deadline=performance.now()+3000;
                    while(queries.some(q=>!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE))&&performance.now()<deadline)
                        await new Promise(resolve=>setTimeout(resolve,10));
                    for(const q of queries) {
                        if(gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)&&!gl.getParameter(extension.GPU_DISJOINT_EXT)) values.push(gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);
                        gl.deleteQuery(q);
                    }
                    if(values.length<100) throw new Error('Too few valid GPU timing samples.');
                    const pixels = new Uint8Array(3840*1920*4);
                    app.autoRender=true;
                    await new Promise(resolve=>app.once('postrender',()=>{
                        gl.readPixels(0,0,3840,1920,gl.RGBA,gl.UNSIGNED_BYTE,pixels);resolve();
                    }));
                    let visible=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]+pixels[i+1]+pixels[i+2]>50)visible++;
                    if(visible<1000)throw new Error(`Loaded scene rendered no visible geometry: ${JSON.stringify({
                        elevation,drawCalls:app.stats.drawCalls, camera:camera.getPosition().toString(),
                        meshCount:content.findByName('textured-surface')?.render?.meshInstances[0]?.instancingCount,
                        meshVisible:content.findByName('textured-surface')?.render?.meshInstances[0]?.visible,
                        meshMask:content.findByName('textured-surface')?.render?.meshInstances[0]?.mask,
                        meshCull:content.findByName('textured-surface')?.render?.meshInstances[0]?.cull,
                        meshPrimitive:content.findByName('textured-surface')?.render?.meshInstances[0]?.mesh?.primitive,
                        meshEnabled:content.findByName('textured-surface')?.enabled,
                        meshTransparent:content.findByName('textured-surface')?.render?.meshInstances[0]?.transparent,
                        meshShaderMask:content.findByName('textured-surface')?.render?.meshInstances[0]?.shaderPassMask,
                        shaderFailed:[...(content.findByName('textured-surface')?.render?.meshInstances[0]?._shaderCache?.values()||[])].map(s=>({failed:s.shader?.failed,
                            vertex:s.shader?.impl?.glVertexShader?gl.getShaderInfoLog(s.shader.impl.glVertexShader):null,
                            fragment:s.shader?.impl?.glFragmentShader?gl.getShaderInfoLog(s.shader.impl.glFragmentShader):null})),
                        layers:app.scene.layers.layerList.map(l=>({id:l.id,name:l.name,meshes:l.meshInstances?.length,enabled:l.enabled})),
                        cameraLayers:camera.camera.layers,
                        diagnostics:document.querySelector('#diagnostics').textContent})}`);
                    values.sort((a,b)=>a-b);
                    const mean=values.reduce((a,b)=>a+b,0)/values.length;
                    scenarios.push({elevation,stereoGpuMeanMs:mean,stereoGpuP90Ms:values[Math.floor(values.length*.9)],
                        renderSubmitMeanMs:cpu.reduce((a,b)=>a+b,0)/cpu.length,visiblePixels:visible,samples:values.length});
                }
                return {renderer,resolution:'3840×1920, two 1920² eyes',headsetMeasured:false,
                    diagnostics:document.querySelector('#diagnostics').textContent,scenarios};
            }).catch(error=>{console.error(JSON.stringify({name:asset.name,errors}));throw error;});
            results.push({name:asset.name,bytes:fs.statSync(asset.file).size,...measured,errors});
            await context.close();
            console.log(JSON.stringify(results.at(-1)));
        }
        fs.mkdirSync(path.dirname(config.output), { recursive: true });
        fs.writeFileSync(config.output, JSON.stringify({measuredAt:new Date().toISOString(),results},null,2));
    } finally {
        await browser?.close();
        await new Promise(resolve=>server.close(resolve));
    }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
