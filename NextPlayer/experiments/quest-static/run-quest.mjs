import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [targetId, variant = 'baseline', port = '52888'] = process.argv.slice(2);
if (!targetId) throw new Error('Usage: node experiments/quest-static/run-quest.mjs TARGET_ID VARIANT [PORT]');
const directory = fileURLToPath(new URL('../../experimental-builds/quest-static/', import.meta.url));
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
const page = pages.find(p => p.id === targetId);
if (!page || !/^http:\/\/localhost:\d+\/next-player\//.test(page.url)) throw new Error('Select the explicitly opened local Quest test player.');
const url = new URL(page.url);
url.searchParams.set('backend', variant === 'webgl' ? 'webgl2' : 'webgpu');
url.searchParams.set('experiment', variant);
const body = (await readFile(path.join(directory, 'main.js'))).toString('base64');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
const pending = new Map(); let nextId = 0;
const send = (method, params = {}, timeout = 15000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
});
let served = false;
ws.addEventListener('message', event => {
    const m = JSON.parse(event.data);
    if (m.id) { const job = pending.get(m.id); pending.delete(m.id); m.error ? job?.reject(new Error(m.error.message)) : job?.resolve(m.result); }
    if (m.method === 'Fetch.requestPaused') {
        send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }, { name: 'Cache-Control', value: 'no-store' }], body })
            .then(() => { served = true; }).catch(error => { console.error(error.message); ws.close(); });
    }
});
const evaluate = async (expression, gesture = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: gesture });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    await send('Page.bringToFront');
    await evaluate('(async()=>{const e=document.querySelector("pc-app");if(e?.ready){const {app}=await e.ready();if(app.xr.active)await app.xr.session.end();}})()');
    await send('Fetch.enable', { patterns: [{ urlPattern: `${url.origin}/next-player/main.js*`, requestStage: 'Request' }] });
    await send('Page.navigate', { url: url.href });
    let ready = false;
    const deadline = Date.now() + 30000;
    while (!ready && Date.now() < deadline) {
        await delay(300);
        if (!served) continue;
        ready = await evaluate('!!globalThis.__emsQuestExperiment && /ready/i.test(document.querySelector("#headline")?.textContent || "")');
    }
    if (!ready) throw new Error('Experimental player did not finish loading.');
    await send('Fetch.disable');
    await evaluate(`(async()=>{
        const {app}=await document.querySelector('pc-app').ready();
        const d=app.graphicsDevice;
        if (__emsQuestExperiment.variant === 'cpu') app.scene.gsplat.renderer=1;
        const p=globalThis.__emsQuestProbe={app, rows:[], errors:[], eyes:{}, start:0, last:0};
        if (d.isWebGPU) {
        const pipelineGet=d.renderPipeline.get;
        d.renderPipeline.get=function(...args){d._questPipelineLabel=args[4]?.name || args[4]?.label;return pipelineGet.apply(this,args);};
        const createPipeline=d.wgpu.createRenderPipeline.bind(d.wgpu);
        d.wgpu.createRenderPipeline=desc=>createPipeline({...desc,label:d._questPipelineLabel || 'Quest raster pipeline'});
        }
        const error=message=>{if(p.errors.length<32)p.errors.push({time:performance.now()-p.start,message})};
        window.addEventListener('error',e=>error(e.message));
        window.addEventListener('unhandledrejection',e=>error(String(e.reason)));
        d.wgpu?.addEventListener('uncapturederror',e=>error(e.error.message));
        d.gpuProfiler.enabled=true;
        const get=XRGPUBinding.prototype.getViewSubImage;
        XRGPUBinding.prototype.getViewSubImage=function(l,v){const s=get.call(this,l,v);p.eyes[v.eye]=[s.viewport.width,s.viewport.height];return s;};
        p.sample=()=>{if(!app.xr.active)return;const t=performance.now();if(!p.start)p.start=t;
            if(p.last&&t-p.start>5000&&p.rows.length<1200) {
                p.sortStart ??= globalThis.__emsQuestStaticRenderer?.sortRuns;
                p.rows.push({interval:t-p.last,gpu:d.gpuProfiler._frameTime,passes:Object.fromEntries(d.gpuProfiler.passTimings || [])});
            }
            p.last=t;};
        app.on('frameend',p.sample);
    })()`);
    if (process.argv.includes('--motion')) await evaluate(`(()=>{
        const p=__emsQuestProbe,c=p.app.root.findByName('camera');
        p.motion=()=>{if(!p.app.xr.active||!p.start||performance.now()-p.start<5000)return;
            p.motionOrigin ??= c.getPosition().clone();
            c.setPosition(p.motionOrigin.x+0.05*Math.sin((performance.now()-p.start)/500),p.motionOrigin.y,p.motionOrigin.z);
        };p.app.on('update',p.motion);
    })()`);
    await evaluate('document.querySelector("#enter-vr").click()', true);
    await delay(22000);
    const result = await evaluate(`(async()=>{
        const p=__emsQuestProbe,a=p.app;
        if(!a.xr.active)throw new Error('XR session did not start: '+JSON.stringify(globalThis.__emsXrDebug));
        if (!Object.keys(p.eyes).length) for (const v of a.root.findByName('camera').camera.camera.xrViews) p.eyes[v.eye || Object.keys(p.eyes).length]=[v.viewport.z,v.viewport.w];
        const result={config:__emsQuestExperiment,eyes:p.eyes,rows:p.rows,errors:p.errors,backend:a.graphicsDevice.isWebGPU?'webgpu':'webgl2',
            motion:!!p.motion,sortsDuringMeasurement:globalThis.__emsQuestStaticRenderer ? __emsQuestStaticRenderer.sortRuns-p.sortStart : null,
            count:a.stats.frame.gsplats,quality:{alpha:a.scene.gsplat.alphaClipForward,contribution:a.scene.gsplat.minContribution,foveation:a.scene.gsplat.foveationStrength},
            adapter:{vendor:a.graphicsDevice.gpuAdapter?.info.vendor,architecture:a.graphicsDevice.gpuAdapter?.info.architecture},
            features:{minSubgroup:a.graphicsDevice.minSubgroupSize,maxSubgroup:a.graphicsDevice.maxSubgroupSize,f16:a.graphicsDevice.supportsShaderF16}};
        a.off('frameend',p.sample);if(p.motion)a.off('update',p.motion);await a.xr.session.end();return result;
    })()`);
    if (process.argv.includes('--verify')) {
        try { result.sortVerification = await evaluate('__emsQuestVerifySort()'); }
        catch (error) { result.sortVerificationError = error.message; process.exitCode = 1; }
    }
    if (!result.rows.length) throw new Error('No measured frames.');
    const mean = key => result.rows.reduce((s,r)=>s+r[key],0)/result.rows.length;
    const passes={}; for(const r of result.rows)for(const [name,ms]of Object.entries(r.passes))passes[name]=(passes[name]||0)+ms/result.rows.length;
    const intervals=result.rows.map(r=>r.interval).sort((a,b)=>a-b);
    result.summary={frames:result.rows.length,frameMs:mean('interval'),p95Ms:intervals[Math.floor(intervals.length*0.95)],fps:1000/mean('interval'),gpuMs:mean('gpu'),passes};
    result.validity = {
        diagnostic: !!result.config.diagnosticFragment,
        startupErrors: result.errors.filter(e => e.time <= 5000).length,
        measuredErrors: result.errors.filter(e => e.time > 5000).length,
        validTimings: result.rows.every(r => Number.isFinite(r.interval) && r.interval > 0 && (result.backend !== 'webgpu' || Number.isFinite(r.gpu) && r.gpu > 0 && r.gpu < 1000)),
        errorFreeRun: result.errors.length === 0 && !result.sortVerificationError
    };
    if (!result.validity.errorFreeRun || !result.validity.validTimings) process.exitCode = 1;
    await mkdir(path.join(directory,'results'),{recursive:true});
    const output=path.join(directory,'results',`${variant}${result.motion?'-motion':''}-${Date.now()}.json`);
    await writeFile(output,JSON.stringify(result,null,2));
    console.log(JSON.stringify({output,config:result.config,motion:result.motion,sortsDuringMeasurement:result.sortsDuringMeasurement,summary:result.summary,eyes:result.eyes,count:result.count,features:result.features,validity:result.validity,errors:result.errors.length,sortVerification:result.sortVerification,sortVerificationError:result.sortVerificationError}));
} finally {
    await send('Fetch.disable').catch(()=>{});
    ws.close();
}
