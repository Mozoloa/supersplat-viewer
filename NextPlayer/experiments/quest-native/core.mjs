// Direct WebGPU core. The bridge supplies decoded immutable data and matrices;
// projection, binning, tile ordering, and compositing have no engine dependency.
export class NativeSplatCore {
    static async create(device, source, order, count, width, height, shader) {
        const self=new NativeSplatCore();
        Object.assign(self,{device,source,order,count,width,height});
        if(count*80>device.limits.maxStorageBufferBindingSize)throw new Error('Scene exceeds this prototype storage-binding capacity.');
        const U=GPUBufferUsage;
        self.owned=[];
        try {
        self.buffer=(size,usage=U.STORAGE|U.COPY_SRC|U.COPY_DST)=>{
            const b=device.createBuffer({size,usage});self.owned.push(b);return b;
        };
        self.tileSize=Number(shader.match(/const TILE_SIZE:u32=(\d+)u/)[1]);
        self.tilesX=Math.ceil(width/self.tileSize);self.tilesY=Math.ceil(height/self.tileSize);
        self.tileCount=self.tilesX*self.tilesY;
        self.capacity=Math.min(count*16,Math.floor(device.limits.maxStorageBufferBindingSize/4));
        self.projected=self.buffer(count*80);
        self.tiles=self.buffer((self.tileCount+3)*16);
        self.members=self.buffer(self.capacity*4);
        self.ranks=self.buffer(count*4);
        self.importance=self.buffer(count*4);
        self.uniform=self.buffer(176,U.UNIFORM|U.COPY_DST);
        self.image=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.TEXTURE_BINDING});
        const module=device.createShaderModule({label:'Native splat core',code:shader.slice(0,shader.indexOf('struct VertexOut'))});
        const errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');
        if(errors.length)throw new Error(errors.map(m=>`${m.lineNum}: ${m.message}`).join('\n'));
        // Explicit layouts keep the same bindings across compute entry points.
        const visibility=GPUShaderStage.COMPUTE|GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT;
        self.layout=device.createBindGroupLayout({entries:[
            ...[0,1].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}})),
            ...[2,3,4].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}})),
            {binding:5,visibility,buffer:{type:'uniform'}},
            {binding:6,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:'write-only',format:'rgba8unorm'}},
            {binding:7,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
            {binding:8,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}}
        ]});
        self.group=device.createBindGroup({layout:self.layout,entries:[source,order,self.projected,self.tiles,self.members,self.uniform].map((buffer,binding)=>({binding,resource:{buffer}})).concat({binding:6,resource:self.image.createView()},{binding:7,resource:{buffer:self.ranks}},{binding:8,resource:{buffer:self.importance}})});
        const layout=device.createPipelineLayout({bindGroupLayouts:[self.layout]});
        self.pipelines={};
        for(const entryPoint of ['mapOrder','project','prefix','scatter','sortTiles','raster'])self.pipelines[entryPoint]=await device.createComputePipelineAsync({label:`Native ${entryPoint}`,layout,compute:{module,entryPoint}});
        // The hardware comparison reads the same projected records without
        // engine meshes, material variants, texture decoding, or per-vertex projection.
        self.drawLayout=device.createBindGroupLayout({entries:[
            {binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
            {binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
            {binding:2,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
            {binding:5,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
            {binding:8,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}}
        ]});
        const drawModule=device.createShaderModule({code:shader.slice(0,shader.indexOf('@compute @workgroup_size(256)')).replace('var<storage,read_write> projected','var<storage,read> projected').replace('var<storage,read_write> importance:array<atomic<u32>>','var<storage,read> importance:array<u32>')+shader.slice(shader.indexOf('struct VertexOut'))});
        self.drawGroup=device.createBindGroup({layout:self.drawLayout,entries:[{binding:0,resource:{buffer:source}},{binding:1,resource:{buffer:order}},{binding:2,resource:{buffer:self.projected}},{binding:5,resource:{buffer:self.uniform}},{binding:8,resource:{buffer:self.importance}}]});
        const makeDraw=(fused,front=false,cull=false)=>device.createRenderPipelineAsync({label:'Native splats',layout:device.createPipelineLayout({bindGroupLayouts:[self.drawLayout]}),vertex:{module:drawModule,entryPoint:'vertex',constants:{FUSED:fused,CULL:cull}},fragment:{module:drawModule,entryPoint:'fragment',targets:[{format:'rgba8unorm',blend:{color:{srcFactor:front?'one-minus-dst-alpha':'one',dstFactor:front?'one':'one-minus-src-alpha'},alpha:{srcFactor:front?'one-minus-dst-alpha':'one',dstFactor:front?'one':'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'},...(front?{depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'less'}}:{})});
        self.drawPipeline=await makeDraw(false);self.fusedPipeline=await makeDraw(true);self.frontPipeline=await makeDraw(true,true);self.prunedPipeline=await makeDraw(true,false,true);
        self.depth=device.createTexture({size:[width,height],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT});
        const occlusionModule=device.createShaderModule({code:`
@group(0) @binding(0) var accumulated:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let xy=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));return vec4f(xy[i],0.0,1.0);}
@fragment fn fragment(@builtin(position) pixel:vec4f)->@builtin(frag_depth) f32 {return select(1.0,0.0,textureLoad(accumulated,vec2i(pixel.xy),0).a>=254.0/255.0);}
`});
        self.occlusionPipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:occlusionModule,entryPoint:'vertex'},fragment:{module:occlusionModule,entryPoint:'fragment',targets:[]},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'always'}});
        self.occlusionGroup=device.createBindGroup({layout:self.occlusionPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:self.image.createView()}]});
        self.queries=device.createQuerySet({type:'timestamp',count:32});
        self.resolve=self.buffer(512,U.QUERY_RESOLVE|U.COPY_SRC);
        self.readback=self.buffer(512,U.MAP_READ|U.COPY_DST);
        return self;
        } catch(error) { self.destroy(); throw error; }
    }
    configure({view,projection,decodeGamma=0,epsilon=1/1024,minPixelSize=2,alphaClip=1/255,tiled=true,mode=tiled?'tiled':'draw'}) {
        const data=new ArrayBuffer(176),f=new Float32Array(data),u=new Uint32Array(data);
        f.set(view,0);f.set(projection,16);u.set([this.width,this.height,this.count,this.tileSize,this.tilesX,this.tilesY,this.capacity,decodeGamma],32);
        f.set([epsilon,minPixelSize,alphaClip],40);u[43]=mode==='occlusion'?2:Number(tiled);
        this.device.queue.writeBuffer(this.uniform,0,data);this.tiled=tiled;this.mode=mode;
    }
    async frame() {
        if(this.tiled&&this.tileCount>this.device.limits.maxComputeWorkgroupsPerDimension)throw new Error('Tile grid exceeds this prototype dispatch capacity.');
        const encoder=this.device.createCommandEncoder();encoder.clearBuffer(this.tiles);
        if(this.tiled)encoder.clearBuffer(this.importance);
        const steps=this.mode==='depth-reject'?['reject']:['fused','pruned'].includes(this.mode)?['draw']:this.mode==='occlusion'?Array.from({length:15},(_,i)=>i%2?'occlusion'+i:'front'+i):this.tiled?['mapOrder','project','prefix','scatter','sortTiles','raster']:['project','draw'];
        for(const [i,name] of steps.entries()) {
            const timestamps={querySet:this.queries,beginningOfPassWriteIndex:i*2,endOfPassWriteIndex:i*2+1};
            if(name==='reject'){
                // Diagnostic only: run the full vertex path but fail every depth
                // test, to separate geometry/binning cost from visible pixels.
                const pass=encoder.beginRenderPass({label:'Geometry-only diagnostic',timestampWrites:timestamps,colorAttachments:[{view:this.image.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:this.depth.createView(),depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'}});
                pass.setPipeline(this.frontPipeline);pass.setBindGroup(0,this.drawGroup);pass.draw(this.count*3);pass.end();
            }else if(name.startsWith('front')){
                const slice=i/2,start=Math.floor(this.count*slice/8),end=Math.floor(this.count*(slice+1)/8);
                const pass=encoder.beginRenderPass({label:name,timestampWrites:timestamps,colorAttachments:[{view:this.image.createView(),clearValue:[0,0,0,0],loadOp:i===0?'clear':'load',storeOp:'store'}],depthStencilAttachment:{view:this.depth.createView(),depthClearValue:1,depthLoadOp:i===0?'clear':'load',depthStoreOp:'store'}});
                pass.setPipeline(this.frontPipeline);pass.setBindGroup(0,this.drawGroup);pass.draw((end-start)*3,1,start*3);pass.end();
            }else if(name.startsWith('occlusion')){
                const pass=encoder.beginRenderPass({label:name,timestampWrites:timestamps,colorAttachments:[],depthStencilAttachment:{view:this.depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
                pass.setPipeline(this.occlusionPipeline);pass.setBindGroup(0,this.occlusionGroup);pass.draw(3);pass.end();
            }else if(name==='draw'){
                const pass=encoder.beginRenderPass({label:'Native draw',timestampWrites:timestamps,colorAttachments:[{view:this.image.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]});
                pass.setPipeline(this.mode==='pruned'?this.prunedPipeline:this.mode==='fused'?this.fusedPipeline:this.drawPipeline);pass.setBindGroup(0,this.drawGroup);pass.draw(this.count*3);pass.end();
            }else{
                const pass=encoder.beginComputePass({label:`Native ${name}`,timestampWrites:timestamps});
                pass.setPipeline(this.pipelines[name]);pass.setBindGroup(0,this.group);
                if(name==='prefix')pass.dispatchWorkgroups(1);
                else if(name==='sortTiles')pass.dispatchWorkgroups(this.tileCount);
                else if(name==='raster')pass.dispatchWorkgroups(this.tilesX,this.tilesY);
                else pass.dispatchWorkgroups(Math.ceil(this.count/(name==='project'?64:256)));
                pass.end();
            }
        }
        encoder.resolveQuerySet(this.queries,0,steps.length*2,this.resolve,0);
        encoder.copyBufferToBuffer(this.resolve,0,this.readback,0,steps.length*16);
        this.device.queue.submit([encoder.finish()]);
        await this.readback.mapAsync(GPUMapMode.READ);
        const timestamps=new BigUint64Array(this.readback.getMappedRange());
        const ms=Object.fromEntries(steps.map((name,i)=>[name,Number(timestamps[i*2+1]-timestamps[i*2])/1e6]));
        this.readback.unmap();return ms;
    }
    async read(buffer,bytes,offset=0) {
        const b=this.device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        try {
        const e=this.device.createCommandEncoder();e.copyBufferToBuffer(buffer,offset,b,0,bytes);this.device.queue.submit([e.finish()]);
        await b.mapAsync(GPUMapMode.READ);return b.getMappedRange().slice(0);
        } finally { b.destroy(); }
    }
    async pixels(){
        const row=Math.ceil(this.width*4/256)*256;
        const b=this.device.createBuffer({size:row*this.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        try {
        const e=this.device.createCommandEncoder();e.copyTextureToBuffer({texture:this.image},{buffer:b,bytesPerRow:row},[this.width,this.height]);this.device.queue.submit([e.finish()]);
        await b.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(b.getMappedRange()),result=new Uint8Array(this.width*this.height*4);
        for(let y=0;y<this.height;y++)result.set(bytes.subarray(y*row,y*row+this.width*4),y*this.width*4);
        return result;
        } finally { b.destroy(); }
    }
    destroy(){this.owned.forEach(b=>b.destroy());this.image?.destroy();this.depth?.destroy();this.queries?.destroy();}
}
