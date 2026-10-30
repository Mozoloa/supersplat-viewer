// Standalone static-splat rasterization prototype. No engine shader includes.
// Projection and Gaussian conventions follow PlayCanvas; see NOTICE.
enable f16;
const TILE_SIZE:u32=8u;
struct Source { center:vec4f, covA:vec4f, covB:vec4f, color:vec4f };
struct Projected { center:vec4f, axes:vec4f, inverse:vec4f, color:vec4f, bounds:vec4u };
struct Tile { count:atomic<u32>, offset:u32, cursor:atomic<u32>, pad:u32 };
struct Params {
    view:mat4x4f, projection:mat4x4f,
    size:vec2u, count:u32, tileSize:u32,
    tilesX:u32, tilesY:u32, capacity:u32, decodeGamma:u32,
    epsilon:f32, minPixelSize:f32, alphaClip:f32, tiled:u32
};
@group(0) @binding(0) var<storage,read> source:array<Source>;
@group(0) @binding(1) var<storage,read> order:array<u32>;
@group(0) @binding(2) var<storage,read_write> projected:array<Projected>;
@group(0) @binding(3) var<storage,read_write> tiles:array<Tile>;
@group(0) @binding(4) var<storage,read_write> members:array<u32>;
@group(0) @binding(5) var<uniform> p:Params;
@group(0) @binding(6) var image:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(7) var<storage,read_write> ranks:array<u32>;
@group(0) @binding(8) var<storage,read_write> importance:array<atomic<u32>>;

fn projectOne(s:Source)->Projected {
    var result:Projected;
    if(s.center.w<=p.alphaClip){return result;}
    let view=p.view*vec4f(s.center.xyz,1.0);
    if(view.z>=0.0){return result;}
    let clip=p.projection*view;
    let v=view.xyz/view.w;
    let focal=f32(p.size.x)*p.projection[0][0];
    let j1=focal/v.z;
    let j2=-j1/v.z*v.xy;
    let rowZ=vec3f(p.view[0].z,p.view[1].z,p.view[2].z);
    let t0=j1*vec3f(p.view[0].x,p.view[1].x,p.view[2].x)+j2.x*rowZ;
    let t1=j1*vec3f(p.view[0].y,p.view[1].y,p.view[2].y)+j2.y*rowZ;
    let row1=vec3f(s.covA.y,s.covB.x,s.covB.y);
    let row2=vec3f(s.covA.z,s.covB.y,s.covB.z);
    let vt0=vec3f(dot(s.covA.xyz,t0),dot(row1,t0),dot(row2,t0));
    let vt1=vec3f(dot(s.covA.xyz,t1),dot(row1,t1),dot(row2,t1));
    let a=dot(t0,vt0)+0.3;let b=dot(t0,vt1);let d=dot(t1,vt1)+0.3;
    let mid=(a+d)*0.5;let radius=length(vec2f((a-d)*0.5,b));
    let lambda1=mid+radius;let lambda2=max(mid-radius,0.1);
    let limit=min(1024.0,f32(min(p.size.x,p.size.y)));
    let l1=2.0*min(sqrt(2.0*lambda1),limit);
    let l2=2.0*min(sqrt(2.0*lambda2),limit);
    if(max(l1,l2)<p.minPixelSize){return result;}
    if(any(abs(clip.xy)-vec2f(max(l1,l2))*clip.ww/vec2f(p.size)>clip.ww)){return result;}
    let direction=normalize(vec2f(b,lambda1-a));
    let axis1=l1*0.5*direction*vec2f(1.0,-1.0);
    let axis2=l2*0.5*vec2f(direction.y,-direction.x)*vec2f(1.0,-1.0);
    let center=(clip.xy/clip.w*vec2f(0.5,-0.5)+0.5)*vec2f(p.size);
    let det=axis1.x*axis2.y-axis1.y*axis2.x;
    let inverse=vec4f(axis2.y,-axis2.x,-axis1.y,axis1.x)/det;
    let alpha=f32(f16(s.center.w));
    let extent=f32(min(f16(1.0),sqrt(max(f16(0.0),log(f16(alpha)/f16(p.alphaClip))))*f16(0.5)));
    let bound=vec2f(length(vec2f(axis1.x,axis2.x)),length(vec2f(axis1.y,axis2.y)));
    let lo=clamp(floor((center-bound)/f32(p.tileSize)),vec2f(0.0),vec2f(f32(p.tilesX),f32(p.tilesY)));
    let hi=clamp(floor((center+bound)/f32(p.tileSize))+1.0,vec2f(0.0),vec2f(f32(p.tilesX),f32(p.tilesY)));
    var color=max(vec3f(vec3h(s.color.xyz)),vec3f(0.0));
    if(p.decodeGamma!=0u){color=pow(color,vec3f(2.2));}
    result.center=vec4f(center,alpha,extent);
    result.axes=vec4f(axis1,axis2);
    result.color=vec4f(vec3f(vec3h(color)),alpha);
    if(p.tiled==1u){result.inverse=inverse;result.bounds=vec4u(vec2u(lo),vec2u(hi));}
    return result;
}

@compute @workgroup_size(256)
fn mapOrder(@builtin(global_invocation_id) gid:vec3u){
    if(gid.x<p.count){ranks[order[gid.x]]=p.count-1u-gid.x;}
}

@compute @workgroup_size(64)
fn project(@builtin(global_invocation_id) gid:vec3u) {
    let rank=gid.x;if(rank>=p.count){return;}
    let result=projectOne(source[rank]);projected[rank]=result;
    if(p.tiled==1u&&result.center.z>0.0){
        for(var y=result.bounds.y;y<result.bounds.w;y++){for(var x=result.bounds.x;x<result.bounds.z;x++){
            atomicAdd(&tiles[y*p.tilesX+x].count,1u);
        }}
    }
}

var<workgroup> scan:array<u32,256>;
var<workgroup> carry:u32;
@compute @workgroup_size(256)
fn prefix(@builtin(local_invocation_index) lane:u32) {
    if(lane==0u){carry=0u;}
    workgroupBarrier();
    let count=p.tilesX*p.tilesY;
    for(var base=0u;base<count;base+=256u){
        let index=base+lane;
        var n=0u;if(index<count){n=atomicLoad(&tiles[index].count);}
        scan[lane]=n;workgroupBarrier();
        for(var shift=1u;shift<256u;shift*=2u){
            var previous=0u;if(lane>=shift){previous=scan[lane-shift];}
            workgroupBarrier();scan[lane]+=previous;workgroupBarrier();
        }
        if(index<count){tiles[index].offset=carry+scan[lane]-n;}
        workgroupBarrier();if(lane==0u){carry+=scan[255];}workgroupBarrier();
    }
    if(lane==0u){atomicStore(&tiles[count].count,carry);}
}

@compute @workgroup_size(256)
fn scatter(@builtin(global_invocation_id) gid:vec3u) {
    if(gid.x>=p.count){return;}
    let s=projected[gid.x];if(s.center.z==0.0){return;}
    for(var y=s.bounds.y;y<s.bounds.w;y++){for(var x=s.bounds.x;x<s.bounds.z;x++){
        let tile=y*p.tilesX+x;
        let slot=tiles[tile].offset+atomicAdd(&tiles[tile].cursor,1u);
        if(slot<p.capacity){members[slot]=ranks[gid.x];}
    }}
}

const MAX_TILE:u32=4096u;
var<workgroup> sorted:array<u32,4096>;
var<workgroup> groupCount:u32;
var<workgroup> groupStart:u32;
@compute @workgroup_size(256)
fn sortTiles(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
    let tile=group.x;
    // Reuse the sort scratch for uniform metadata so this entry point remains
    // within the portable 16 KiB workgroup-storage limit.
    if(lane==0u){sorted[0]=atomicLoad(&tiles[tile].count);sorted[1]=tiles[tile].offset;}
    let count=workgroupUniformLoad(&sorted[0]);let start=workgroupUniformLoad(&sorted[1]);
    if(lane==0u){atomicMax(&tiles[p.tilesX*p.tilesY+1u].count,count);}
    if(count>MAX_TILE||start+count>p.capacity){if(lane==0u){atomicAdd(&tiles[p.tilesX*p.tilesY+2u].count,1u);}return;}
    var n=1u;while(n<count){n*=2u;}
    for(var i=lane;i<n;i+=256u){sorted[i]=0xffffffffu;if(i<count){sorted[i]=members[start+i];}}
    workgroupBarrier();
    for(var k=2u;k<=n;k*=2u){for(var j=k/2u;j>0u;j/=2u){
        for(var i=lane;i<n;i+=256u){let other=i^j;if(other>i){
            let a=sorted[i];let b=sorted[other];let up=(i&k)==0u;
            sorted[i]=select(max(a,b),min(a,b),up);sorted[other]=select(min(a,b),max(a,b),up);
        }}workgroupBarrier();
    }}
    for(var i=lane;i<count;i+=256u){members[start+i]=sorted[i];}
}

var<workgroup> batch:array<Projected,128>;
var<workgroup> completed:atomic<u32>;
var<workgroup> allCompleted:u32;
@compute @workgroup_size(TILE_SIZE,TILE_SIZE)
fn raster(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_id) local:vec3u,@builtin(local_invocation_index) lane:u32){
    let tile=group.y*p.tilesX+group.x;
    if(lane==0u){groupCount=atomicLoad(&tiles[tile].count);groupStart=tiles[tile].offset;}
    let count=workgroupUniformLoad(&groupCount);let start=workgroupUniformLoad(&groupStart);
    let pixel=group.xy*TILE_SIZE+local.xy;let valid=all(pixel<p.size);
    if(count>MAX_TILE||start+count>p.capacity){if(valid){textureStore(image,pixel,vec4f(1.0,0.0,1.0,1.0));}return;}
    var color=vec3f(0.0);var transmittance=1.0;
    for(var base=0u;base<count;base+=128u){
        let n=min(128u,count-base);
        for(var i=lane;i<n;i+=TILE_SIZE*TILE_SIZE){batch[i]=projected[order[p.count-1u-members[start+base+i]]];}
        if(lane==0u){atomicStore(&completed,0u);}workgroupBarrier();
        if(valid&&transmittance>p.epsilon){for(var j=0u;j<n;j++){
            let s=batch[j];let delta=vec2f(pixel)+0.5-s.center.xy;
            let uv=vec2h(vec2f(dot(s.inverse.xy,delta),dot(s.inverse.zw,delta)));
            let r=dot(uv,uv);
            if(r>f16(1.0)){continue;}
            let e=exp(f16(-4.0));let alpha=f32((exp(f16(-4.0)*r)-e)/(f16(1.0)-e)*f16(s.center.z));
            if(alpha<f32(f16(p.alphaClip))){continue;}
            let sourceId=order[p.count-1u-members[start+base+j]];
            atomicMax(&importance[sourceId],bitcast<u32>(transmittance*alpha*max(1.0,max(s.color.x,max(s.color.y,s.color.z)))));
            color+=transmittance*alpha*s.color.xyz;transmittance*=1.0-alpha;
            if(transmittance<=p.epsilon){break;}
        }}
        atomicAdd(&completed,select(0u,1u,!valid||transmittance<=p.epsilon));workgroupBarrier();
        if(lane==0u){allCompleted=atomicLoad(&completed);}
        if(workgroupUniformLoad(&allCompleted)==TILE_SIZE*TILE_SIZE){break;}
        workgroupBarrier();
    }
    if(valid){textureStore(image,pixel,vec4f(color,1.0-transmittance));}
}

struct VertexOut { @builtin(position) position:vec4f,@location(0) uv:vec2h,@location(1) color:vec4h };
override FUSED:bool=false;
override CULL:bool=false;
@vertex fn vertex(@builtin(vertex_index) index:u32)->VertexOut {
    let rank=order[select(index/3u,p.count-1u-index/3u,p.tiled==2u)];
    var out:VertexOut;out.position=vec4f(0.0,0.0,2.0,1.0);
    if(CULL&&bitcast<f32>(importance[rank])<p.epsilon){return out;}
    var s:Projected;if(FUSED){s=projectOne(source[rank]);}else{s=projected[rank];}
    if(s.center.z==0.0){return out;}
    let corners=array<vec2h,3>(vec2h(0.0,2.0),vec2h(-1.73205080757,-1.0),vec2h(1.73205080757,-1.0));
    let uv=corners[index%3u]*f16(s.center.w);
    let pixel=s.center.xy+s.axes.xy*f32(uv.x)+s.axes.zw*f32(uv.y);
    out.position=vec4f((pixel/vec2f(p.size)-0.5)*vec2f(2.0,-2.0),0.5,1.0);
    out.uv=uv;out.color=vec4h(vec4f(s.color.xyz,s.center.z));return out;
}
@fragment fn fragment(input:VertexOut)->@location(0) vec4f {
    let r=dot(input.uv,input.uv);if(r>f16(1.0)){discard;}
    let e=exp(f16(-4.0));let alpha=(exp(f16(-4.0)*r)-e)/(f16(1.0)-e)*input.color.w;
    if(alpha<f16(p.alphaClip)){discard;}
    return vec4f(vec3f(input.color.xyz)*f32(alpha),f32(alpha));
}
