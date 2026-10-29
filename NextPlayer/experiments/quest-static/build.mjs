import { rollup } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { questEngineExperiment, variants } from './engine-plugin.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'experimental-builds/quest-static');
const bundle = await rollup({
    input: path.join(root, 'experiments/quest-static/entry.mjs'),
    plugins: [questEngineExperiment(), resolve(), typescript({ tsconfig: path.join(root, 'tsconfig.json'), sourceMap: false })]
});
await mkdir(path.join(output, 'schema'), { recursive: true });
await bundle.write({ file: path.join(output, 'main.js'), format: 'esm', sourcemap: false });
await bundle.close();
await Promise.all([
    copyFile(path.join(root, 'src/index.html'), path.join(output, 'index.html')),
    copyFile(path.join(root, 'src/style.css'), path.join(output, 'style.css')),
    copyFile(path.join(root, 'schema/ems-spatial-scene-v1.schema.json'), path.join(output, 'schema/ems-spatial-scene-v1.schema.json')),
    writeFile(path.join(output, 'experiment.json'), JSON.stringify({ name: 'Quest static renderer experiment', engine: '2.21.3', variants, defaultVariant: 'static-subgroup2-triangle', production: false }, null, 2))
]);
console.log(`Experimental build only: ${output}`);
