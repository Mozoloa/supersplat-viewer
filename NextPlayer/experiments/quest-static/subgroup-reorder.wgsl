// Stable radix scatter specialized for this Quest's 64/128-lane subgroups.
// Unlike OneSweep, no workgroup waits for another workgroup to make progress.
@group(0) @binding(0) var<storage, read> inputKeys: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputKeys: array<u32>;
@group(0) @binding(2) var<storage, read> prefix_block_sum: array<u32>;
@group(0) @binding(3) var<storage, read> inputValues: array<u32>;
@group(0) @binding(4) var<storage, read_write> outputValues: array<u32>;
struct RadixSortUniforms { workgroupCount: u32, elementCount: u32 };
@group(0) @binding(5) var<uniform> uniforms: RadixSortUniforms;
#ifdef USE_INDIRECT_SORT
@group(0) @binding(6) var<storage, read> sortElementCount: array<u32>;
#endif
const CURRENT_BIT: u32 = {CURRENT_BIT}u;
const IS_FIRST_PASS: u32 = {IS_FIRST_PASS}u;
const IS_LAST_PASS: u32 = {IS_LAST_PASS}u;
const ROUNDS: u32 = {ELEMENTS_PER_THREAD}u;
var<workgroup> counts: array<u32, 64>;
var<workgroup> offsets: array<u32, 16>;
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(workgroup_id) group: vec3u,
        @builtin(num_workgroups) dimensions: vec3u,
        @builtin(local_invocation_index) localIndex: u32,
        @builtin(subgroup_id) wave: u32,
        @builtin(subgroup_size) waveSize: u32,
        @builtin(subgroup_invocation_id) lane: u32) {
    let groupIndex = group.x + group.y * dimensions.x;
    // Define the logical input order by subgroup/lane, without assuming how
    // local_invocation_index is mapped onto hardware lanes.
    let tid = wave * waveSize + lane;
    if (localIndex < 64u) { counts[localIndex] = 0u; }
    if (localIndex < 16u) { offsets[localIndex] = 0u; }
    workgroupBarrier();
    #ifdef USE_INDIRECT_SORT
    let length = sortElementCount[0];
    #else
    let length = uniforms.elementCount;
    #endif
    for (var round = 0u; round < ROUNDS; round++) {
        let index = groupIndex * 256u * ROUNDS + round * 256u + tid;
        let valid = index < length;
        let key = inputKeys[select(0u, index, valid)];
        let digit = (key >> CURRENT_BIT) & 15u;
        let value = select(inputValues[select(0u, index, valid)], index, IS_FIRST_PASS == 1u);
        var peers = subgroupBallot(valid);
        for (var bit = 0u; bit < 4u; bit++) {
            let bitSet = (digit & (1u << bit)) != 0u;
            let mask = subgroupBallot(bitSet);
            peers &= select(~mask, mask, vec4<bool>(bitSet));
        }
        let word = lane >> 5u;
        var rank = 0u;
        for (var i = 0u; i < word; i++) { rank += countOneBits(peers[i]); }
        rank += countOneBits(peers[word] & ((1u << (lane & 31u)) - 1u));
        if (valid && rank == 0u) {
            let bits = countOneBits(peers);
            counts[digit * 4u + wave] = bits.x + bits.y + bits.z + bits.w;
        }
        workgroupBarrier();
        var prefix = offsets[digit] + rank;
        for (var i = 0u; i < wave; i++) { prefix += counts[digit * 4u + i]; }
        if (valid) {
            let outputIndex = prefix_block_sum[digit * uniforms.workgroupCount + groupIndex] + prefix;
            if (IS_LAST_PASS == 0u) { outputKeys[outputIndex] = key; }
            outputValues[outputIndex] = value;
        }
        if (round < ROUNDS - 1u) {
            workgroupBarrier();
            if (localIndex < 16u) {
                var total = 0u;
                for (var i = 0u; i < 4u; i++) {
                    total += counts[localIndex * 4u + i];
                    counts[localIndex * 4u + i] = 0u;
                }
                offsets[localIndex] += total;
            }
            workgroupBarrier();
        }
    }
}
