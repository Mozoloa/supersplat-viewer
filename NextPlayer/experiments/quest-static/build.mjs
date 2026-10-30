import { rollup } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { questEngineExperiment, variants } from './engine-plugin.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const published = process.argv.includes('--publish');
const gitOptions = ['-c', `safe.directory=${path.resolve(root, '..').replaceAll('\\', '/')}`];
const revision = execFileSync('git', [...gitOptions, 'rev-parse', '--short=12', 'HEAD'], {cwd:root,encoding:'utf8'}).trim();
const dirty = !!execFileSync('git', [...gitOptions, 'status', '--porcelain', '--', '.'], {cwd:root,encoding:'utf8'}).trim();
if (published && dirty) throw new Error('Commit all NextPlayer source changes before publishing.');
const build = revision + (dirty ? '-dirty' : '');
const output = published ? path.resolve(root, '../../webapp/public/next-player-experimental') : path.join(root, 'experimental-builds/quest-static');
const bundle = await rollup({
    input: path.join(root, `experiments/quest-static/${published ? 'player-entry' : 'entry'}.mjs`),
    plugins: [questEngineExperiment({build,published}), resolve(), typescript({ tsconfig: path.join(root, 'tsconfig.json'), sourceMap: false })]
});
await mkdir(path.join(output, 'schema'), { recursive: true });
await bundle.write({ file: path.join(output, 'main.js'), format: 'esm', sourcemap: false });
await bundle.close();
const bundleHash = createHash('sha256').update(await readFile(path.join(output, 'main.js'))).digest('hex').slice(0,16);
const html = (await readFile(path.join(root, 'src/index.html'), 'utf8')).replace(/\.\/main\.js\?v=[^"']+/, `./main.js?v=${bundleHash}`);
await Promise.all([
    writeFile(path.join(output, 'index.html'), html),
    copyFile(path.join(root, 'src/style.css'), path.join(output, 'style.css')),
    copyFile(path.join(root, 'schema/ems-spatial-scene-v1.schema.json'), path.join(output, 'schema/ems-spatial-scene-v1.schema.json')),
    writeFile(path.join(output, 'experiment.json'), JSON.stringify({ name: 'Quest static renderer experiment', engine: '2.21.3', variants, defaultVariant: 'static-cov-subgroup2-triangle', build, bundleHash, published }, null, 2))
]);
console.log(`${published ? 'Publishable experimental player' : 'Local experimental player'}: ${output} (${build})`);
