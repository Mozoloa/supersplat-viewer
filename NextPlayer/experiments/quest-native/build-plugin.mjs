import { readFileSync } from 'node:fs';

// QA module loading only; no engine transformations or published runtime code.
export function nativeProbeSource() {
    return {
        name:'quest-native-probe-source',
        resolveId(id){if(id==='quest-native-wgsl')return '\0quest-native-wgsl';},
        load(id){if(id==='\0quest-native-wgsl')return `export default ${JSON.stringify(readFileSync(new URL('./core.wgsl',import.meta.url),'utf8'))};`;}
    };
}
