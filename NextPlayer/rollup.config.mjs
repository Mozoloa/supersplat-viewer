import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import copy from 'rollup-plugin-copy';

export default {
    input: 'src/main.ts',
    output: [
        {
            file: 'public/main.js',
            format: 'esm',
            sourcemap: true
        },
        {
            file: '../../webapp/public/next-player/main.js',
            format: 'esm',
            sourcemap: true
        }
    ],
    plugins: [
        resolve(),
        typescript(),
        copy({
            targets: [
                { src: 'src/index.html', dest: 'public' },
                { src: 'src/style.css', dest: 'public' },
                { src: 'schema/ems-spatial-scene-v1.schema.json', dest: 'public/schema' },
                { src: 'src/index.html', dest: '../../webapp/public/next-player' },
                { src: 'src/style.css', dest: '../../webapp/public/next-player' },
                { src: 'schema/ems-spatial-scene-v1.schema.json', dest: '../../webapp/public/next-player/schema' }
            ]
        })
    ]
};
