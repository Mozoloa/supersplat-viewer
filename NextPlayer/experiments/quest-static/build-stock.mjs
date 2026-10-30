// Compare an unpacked official engine release without changing the pinned app
// dependencies or applying any of this experiment's engine transformations.
import {rollup} from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
if(!process.argv[2])throw new Error('Usage: node build-stock.mjs UNPACKED_ENGINE_PACKAGE');
const engineRoot=path.resolve(process.argv[2]);
const pkg=JSON.parse(await readFile(path.join(engineRoot,'package.json'),'utf8'));
if(pkg.name!=='playcanvas')throw new Error('Expected an official playcanvas package.');
const entry='\0quest-stock-entry';
const output=path.join(root,'experimental-builds/quest-stock');
const bundle=await rollup({input:entry,plugins:[{
    name:'stock-engine-comparison',
    resolveId(id){
        if(id===entry)return id;
        if(id==='playcanvas')return path.join(engineRoot,'build/playcanvas/src/index.js');
        if(id.startsWith('playcanvas/'))return path.join(engineRoot,id.slice('playcanvas/'.length));
    },
    load(id){if(id===entry)return `
        import ${JSON.stringify(path.join(root,'src/main.ts'))};
        globalThis.__emsQuestExperiment={variant:'stock',engine:${JSON.stringify(pkg.version)},published:false,build:'stock-comparison',reason:'Stock engine comparison'};
    `;}
},resolve(),typescript({tsconfig:path.join(root,'tsconfig.json'),sourceMap:false})]});
await mkdir(output,{recursive:true});
await bundle.write({file:path.join(output,'main.js'),format:'esm',sourcemap:false});
await bundle.close();
console.log(`Stock PlayCanvas ${pkg.version}: ${output}`);
