import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const [target,width='1680',height='1760',modeList='fused',frames='10',eye='']=process.argv.slice(2);
if(!target)throw new Error('Usage: node experiments/quest-native/run-probe.mjs TARGET [WIDTH HEIGHT MODES FRAMES EYE]');
if(eye&&!['left','right'].includes(eye))throw new Error('Eye must be left or right.');
const shaderCode=await readFile(new URL('./core.wgsl',import.meta.url),'utf8');
const moduleUrl='data:text/javascript;base64,'+(await readFile(new URL('./core.mjs',import.meta.url))).toString('base64');
const options={width:Number(width),height:Number(height),modes:modeList.split(','),frames:Number(frames),shaderCode};
const pages=await(await fetch('http://127.0.0.1:52888/json/list')).json();
const page=pages.find(p=>p.id===target);
const url=new URL(page?.url||'about:blank');
if(url.protocol!=='https:'||url.pathname!=='/next-player-experimental/index.html'||url.searchParams.get('quest-benchmark')!=='1')throw new Error('Select an explicit HTTPS QA tab.');
const expression=`(async()=>{
    const {NativeSplatCore}=await import(${JSON.stringify(moduleUrl)});
    const {app}=await document.querySelector('pc-app').ready();
    const c=app.root.findByName('camera');
    const saved={position:c.getPosition().clone(),rotation:c.getRotation().clone(),projection:c.camera.calculateProjection,radial:app.scene.gsplat.radialSorting};
    const eye=${JSON.stringify(eye)};
    try {
        if(eye){
            const e=globalThis.__emsQuestProbe?.xrProjections?.find(e=>e.eye===eye);
            if(!e)throw new Error('Capture XR projections with run-quest.mjs first.');
            const base=c.getWorldTransform().clone(),world=base.clone().mul2(base,base.clone().set(e.eyeTransform));
            c.setPosition(world.getTranslation());c.setEulerAngles(world.getEulerAngles());
            c.camera.calculateProjection=m=>m.set(e.projection);app.scene.gsplat.radialSorting=true;
        }
        const result=await __emsQuestNativeBench({...${JSON.stringify(options)},Core:NativeSplatCore});
        return {...result,eye,scope:'Frozen offscreen GPU stage; captured eye projection is not a live XR frame benchmark'};
    } finally {
        c.setPosition(saved.position);c.setRotation(saved.rotation);c.camera.calculateProjection=saved.projection;
        app.scene.gsplat.radialSorting=saved.radial;app.renderNextFrame=true;
    }
})()`;
const socket=new WebSocket(page.webSocketDebuggerUrl);
const timeout=setTimeout(()=>socket.close(),55000);
try{
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    const result=await new Promise((resolve,reject)=>{
        socket.addEventListener('message',event=>{
            const m=JSON.parse(event.data);if(m.id!==1)return;
            if(m.error||m.result.exceptionDetails)reject(new Error(m.error?.message||m.result.exceptionDetails.exception?.description?.split('\n')[0]||m.result.exceptionDetails.text));
            else resolve(m.result.result.value);
        });
        socket.addEventListener('close',()=>reject(new Error('Probe connection closed or timed out.')),{once:true});
        socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
    });
    const directory=new URL('../../experimental-builds/quest-native/results/',import.meta.url);
    await mkdir(directory,{recursive:true});
    const output=new URL(`native-${Date.now()}.json`,directory);
    await writeFile(output,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({output:fileURLToPath(output),...result}));
}finally{clearTimeout(timeout);socket.close();}
