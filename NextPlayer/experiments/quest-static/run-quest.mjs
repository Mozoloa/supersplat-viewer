import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [targetId, variant = 'baseline', port = '52888'] = process.argv.slice(2);
const flat = process.argv.includes('--flat');
const ar = process.argv.includes('--ar');
if (flat && ar) throw new Error('--ar requires an immersive XR run.');
if (flat && process.argv.includes('--motion')) throw new Error('--motion requires an immersive XR run.');
if (!targetId) throw new Error('Usage: node experiments/quest-static/run-quest.mjs TARGET_ID VARIANT [PORT]');
const directory = fileURLToPath(new URL('../../experimental-builds/quest-static/', import.meta.url));
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
const page = pages.find(p => p.id === targetId);
if (!page) throw new Error('Quest test tab not found.');
const url = new URL(page.url);
if (!(url.protocol === 'https:' && url.pathname === '/next-player-experimental/index.html' && url.searchParams.get('quest-benchmark') === '1')) throw new Error('Select an explicitly opened HTTPS Quest benchmark tab.');
url.searchParams.set('backend', variant === 'webgl' ? 'webgl2' : 'webgpu');
url.searchParams.set('experiment', variant);
const bundleArg = process.argv.indexOf('--bundle');
const body = (await readFile(bundleArg >= 0 ? process.argv[bundleArg+1] : path.join(directory, 'main.js'))).toString('base64');
const assetArg=process.argv.indexOf('--asset');
const asset=assetArg>=0?await readFile(process.argv[assetArg+1]):null;
const assetUrl=new URL(url.searchParams.get('content'),url).href;
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
        const isAsset=!!asset&&m.params.request.url===assetUrl;
        const range=isAsset&&m.params.request.headers.Range?.match(/bytes=(\d+)-(\d*)/i);
        const start=range?Number(range[1]):0,end=range?Math.min(asset.length-1,range[2]?Number(range[2]):asset.length-1):asset?.length-1;
        const headers=[{name:'Content-Type',value:isAsset?'application/octet-stream':'application/javascript'},{name:'Cache-Control',value:'no-store'}];
        if(isAsset){headers.push({name:'Content-Length',value:String(end-start+1)});if(range)headers.push({name:'Content-Range',value:`bytes ${start}-${end}/${asset.length}`});}
        send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: range?206:200, responseHeaders:headers, body:isAsset?asset.subarray(start,end+1).toString('base64'):body })
            .then(() => { if(!isAsset)served = true; }).catch(error => { console.error(error.message); ws.close(); });
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
    await evaluate('(async()=>{const e=document.querySelector("pc-app");if(e?.ready){const {app}=await e.ready();if(app.xr.active)await new Promise((resolve,reject)=>app.xr.end(error=>error?reject(error):resolve()));}})()');
    await send('Fetch.enable', { patterns: [{ urlPattern: new URL('main.js*', url).href, requestStage: 'Request' },...(asset?[{urlPattern:assetUrl,requestStage:'Request'}]:[])] });
    await send('Page.navigate', { url: url.href });
    let ready = false;
    let acceptedDevelopmentCertificate=false;
    const deadline = Date.now() + 30000;
    while (!ready && Date.now() < deadline) {
        await delay(300);
        if (!served) {
            // Meta Browser requires its private-CA acknowledgement again on
            // debugger navigation. Use its normal interstitial only for this
            // explicitly selected, already-authorized LAN development origin.
            if(!acceptedDevelopmentCertificate&&url.hostname==='192.168.1.35'&&await evaluate('document.title==="Privacy error"&&document.body.innerText.includes("NET::ERR_CERT_AUTHORITY_INVALID")')){
                acceptedDevelopmentCertificate=true;
                await evaluate('document.getElementById("details-button").click();document.getElementById("proceed-link").click()',true);
            }
            continue;
        }
        ready = await evaluate('!!globalThis.__emsQuestExperiment && /ready/i.test(document.querySelector("#headline")?.textContent || "")');
    }
    if (!ready) throw new Error('Experimental player did not finish loading: '+JSON.stringify(await evaluate('({title:document.title,headline:document.querySelector("#headline")?.textContent,notice:document.querySelector("#notice")?.textContent})')));
    await send('Fetch.disable');
    if(process.argv.includes('--load-only')) {
        console.log(JSON.stringify({targetId,loaded:true,config:await evaluate('__emsQuestExperiment')}));
    } else {
    await evaluate(`(async()=>{
        const {app}=await document.querySelector('pc-app').ready();
        const d=app.graphicsDevice;
        if (__emsQuestExperiment.variant === 'cpu') app.scene.gsplat.renderer=1;
        const p=globalThis.__emsQuestProbe={app, rows:[], errors:[], eyes:{}, start:0, last:0, flat:${flat}};
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
        if (${process.argv.includes('--standard')}) {
            app.scene.gsplat.renderer=1;
            await new Promise(resolve=>{app.once('frameend',resolve);app.renderNextFrame=true;});
            __emsConfigureQuestExperiment({isWebGPU:false},true);
            app.scene.gsplat.renderer=2;
        }
        d.gpuProfiler.enabled=true;
        if (!p.flat && typeof XRGPUBinding !== 'undefined') {
            const get=XRGPUBinding.prototype.getViewSubImage;
            XRGPUBinding.prototype.getViewSubImage=function(l,v){const s=get.call(this,l,v);p.eyes[v.eye]=[s.viewport.width,s.viewport.height];return s;};
        }
        p.sample=()=>{if(!p.flat&&!app.xr.active)return;const t=performance.now();if(!p.start)p.start=t;
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
    if (!flat) await evaluate(`document.querySelector("#enter-${ar ? 'ar' : 'vr'}").click()`, true);
    await delay(22000);
    const result = await evaluate(`(async()=>{
        const p=__emsQuestProbe,a=p.app;
        if(!p.flat&&!a.xr.active)throw new Error('XR session did not start: '+JSON.stringify(globalThis.__emsXrDebug));
        if (!p.flat&&!Object.keys(p.eyes).length) for (const v of a.root.findByName('camera').camera.camera.xrViews) p.eyes[v.eye || Object.keys(p.eyes).length]=[v.viewport.z,v.viewport.w];
        const staticRenderer=globalThis.__emsQuestStaticRenderer;
        if(!p.flat){const c=a.root.findByName('camera'),inverse=c.getWorldTransform().clone().invert();p.xrProjections=c.camera.camera.xrViews.map(v=>({eye:v.eye,projection:Array.from(v._xrView.projectionMatrix),eyeTransform:Array.from(inverse.clone().mul2(inverse,v.viewInvOffMat).data)}));}
        const vertexCode=staticRenderer ? [...staticRenderer.material.variants.values()].map(s=>s.impl._vertexCode||'').join(' ') : '';
        const result={config:__emsQuestExperiment,eyes:p.eyes,rows:p.rows,errors:p.errors,backend:a.graphicsDevice.isWebGPU?'webgpu':'webgl2',
            mode:p.flat?'flat':'immersive-${ar ? 'ar' : 'vr'}',capabilitySimulation:${process.argv.includes('--standard')},xrProjections:p.xrProjections,
            activeOptimizations:{covarianceCache:vertexCode.includes('let a = questCovariance['),smallCaps:vertexCode.includes('let questUV=source.cornerUV*extent')},
            geometryCache:staticRenderer?.covarianceCache ? {bytes:staticRenderer.covarianceCache.output.byteSize,rebuilds:staticRenderer.covarianceCache.rebuilds} : null,
            motion:!!p.motion,sortsDuringMeasurement:globalThis.__emsQuestStaticRenderer ? __emsQuestStaticRenderer.sortRuns-p.sortStart : null,
            count:a.stats.frame.gsplats,quality:{alpha:a.scene.gsplat.alphaClipForward,contribution:a.scene.gsplat.minContribution,foveation:a.scene.gsplat.foveationStrength,minPixelSize:a.scene.gsplat.minPixelSize,antialias:a.scene.gsplat.antiAlias,samples:a.graphicsDevice.samples},
            adapter:{vendor:a.graphicsDevice.gpuAdapter?.info.vendor,architecture:a.graphicsDevice.gpuAdapter?.info.architecture},
            features:{minSubgroup:a.graphicsDevice.minSubgroupSize,maxSubgroup:a.graphicsDevice.maxSubgroupSize,f16:a.graphicsDevice.supportsShaderF16}};
        a.off('frameend',p.sample);if(p.motion)a.off('update',p.motion);
        if(a.xr.active)await new Promise((resolve,reject)=>a.xr.end(error=>error?reject(error):resolve()));return result;
    })()`);
    result.scene = url.searchParams.get('content');
    result.assetReplacement=asset?path.basename(process.argv[assetArg+1]):null;
    if(process.argv.includes('--image')){
        result.imageComparison=await evaluate("__emsQuestVerifyImage(1680,1760,'draw-state')");
        const chunks=[];
        for(let offset=0;offset<1680*1760*4;offset+=1024*1024){
            const data=await evaluate(`(()=>{const a=__emsQuestComparisonPixels.candidate.subarray(${offset},${offset+1024*1024});let s='';for(let i=0;i<a.length;i+=16384)s+=String.fromCharCode(...a.subarray(i,i+16384));return btoa(s);})()`);
            chunks.push(Buffer.from(data,'base64'));
        }
        await mkdir(path.join(directory,'results'),{recursive:true});
        result.imageFile=path.join(directory,'results',`${asset?path.basename(process.argv[assetArg+1]):'original'}-${Date.now()}.rgba`);
        await writeFile(result.imageFile,Buffer.concat(chunks));
    }
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
    result.validity.expectedOptimizations = (!result.config.covarianceCache || result.activeOptimizations.covarianceCache)&&(!result.config.staticGpu||result.config.support>=1||result.activeOptimizations.smallCaps);
    if (!result.validity.errorFreeRun || !result.validity.validTimings || !result.validity.expectedOptimizations) process.exitCode = 1;
    await mkdir(path.join(directory,'results'),{recursive:true});
    const output=path.join(directory,'results',`${variant}${flat?'-flat':ar?'-ar':''}${result.motion?'-motion':''}-${Date.now()}.json`);
    await writeFile(output,JSON.stringify(result,null,2));
    console.log(JSON.stringify({output,mode:result.mode,config:result.config,motion:result.motion,sortsDuringMeasurement:result.sortsDuringMeasurement,summary:result.summary,eyes:result.eyes,count:result.count,features:result.features,validity:result.validity,errors:result.errors.length,sortVerification:result.sortVerification,sortVerificationError:result.sortVerificationError,imageFile:result.imageFile}));
    }
} finally {
    await send('Fetch.disable').catch(()=>{});
    ws.close();
}
