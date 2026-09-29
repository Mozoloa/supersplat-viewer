import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import copy from 'rollup-plugin-copy';
import path from 'node:path';

const destinations = ['public', '../../webapp/public/next-player', ...(process.env.EMS_PLAYER_TARGETS || '').split(path.delimiter).filter(Boolean)];

export default {
    input: 'src/main.ts',
    output: destinations.map(dest => ({ file: path.join(dest, 'main.js'), format: 'esm', sourcemap: true })),
    plugins: [
        resolve(),
        typescript(),
        copy({
            targets: destinations.flatMap(dest => [
                { src: 'src/index.html', dest }, { src: 'src/style.css', dest },
                { src: 'schema/ems-spatial-scene-v1.schema.json', dest: path.join(dest, 'schema') }
            ])
        })
    ]
};
