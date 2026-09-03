import { CULLFACE_NONE, FILTER_LINEAR, MeshInstance, SEMANTIC_POSITION, ShaderMaterial, Texture, createSphere,
    type AppBase, type Entity } from 'playcanvas';

type PlayerUi = {
    headline: HTMLElement; detail: HTMLElement; diagnostics: HTMLElement; notice: HTMLElement; progress: HTMLElement;
    reset: HTMLButtonElement; playback: HTMLButtonElement; ar: HTMLButtonElement; vr: HTMLButtonElement;
};

/** A separate media renderer in the shared player; no splat decoding or scene placement. */
export async function playStereoVideo(app: AppBase, camera: Entity, root: Entity, url: string, ui: PlayerUi): Promise<void> {
    camera.addComponent('camera', { fov: 75, nearClip: 0.01, farClip: 100 });
    const video = document.createElement('video');
    video.crossOrigin = new URL(url).origin === location.origin ? 'use-credentials' : 'anonymous';
    video.playsInline = true;
    video.loop = true;
    video.preload = 'auto';
    const texture = new Texture(app.graphicsDevice, { name: 'Stereo video', mipmaps: false,
        minFilter: FILTER_LINEAR, magFilter: FILTER_LINEAR, flipY: false });
    const material = new ShaderMaterial({
        uniqueName: 'EMS_StereoVideo',
        attributes: { vertex_position: SEMANTIC_POSITION },
        vertexGLSL: `
            attribute vec3 vertex_position;
            uniform mat4 matrix_view;
            uniform mat4 matrix_projection;
            uniform uint view_index;
            uniform float stereoActive;
            varying vec3 direction;
            flat varying float eye;
            void main(void) {
                direction = vertex_position;
                eye = float(view_index) * stereoActive;
                // Rotation only: VR180 is a fixed viewpoint, not a 6DoF scene.
                gl_Position = matrix_projection * vec4(mat3(matrix_view) * vertex_position * 10.0, 1.0);
            }`,
        fragmentGLSL: `
            precision highp float;
            uniform sampler2D videoTexture;
            varying vec3 direction;
            flat varying float eye;
            void main(void) {
                vec3 d = normalize(direction);
                float yaw = atan(d.x, -d.z);
                if (abs(yaw) > 1.570796327) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
                float u = (yaw / 3.141592654 + 0.5 + eye) * 0.5;
                float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / 3.141592654;
                gl_FragColor = texture2D(videoTexture, vec2(u, v));
            }`
    });
    material.cull = CULLFACE_NONE;
    material.depthWrite = false;
    material.setParameter('videoTexture', texture);
    const sphere = new MeshInstance(createSphere(app.graphicsDevice,
        { radius: 1, latitudeBands: 32, longitudeBands: 64 }), material);
    // This background follows head rotation; world-space culling must not hide it.
    sphere.cull = false;
    root.addComponent('render', { meshInstances: [sphere] });
    ui.headline.textContent = 'Stereo';
    ui.detail.textContent = 'Loading video…';
    ui.ar.hidden = true;
    ui.playback.hidden = false;
    ui.playback.textContent = 'Play';
    ui.reset.title = 'Reset view and playback';
    const hint = document.querySelector<HTMLElement>('.hint');
    if (hint) hint.textContent = 'Drag to look around · Play for sound · Enter VR for stereo';
    const report = (error: unknown): void => {
        ui.notice.textContent = error instanceof Error ? error.message : String(error);
        ui.notice.dataset.level = 'error';
    };
    video.addEventListener('loadedmetadata', () => {
        ui.detail.textContent = `${video.videoWidth} × ${video.videoHeight} · ${video.duration.toFixed(1)} s`;
        ui.diagnostics.textContent = 'VR180 · left/right · 180° × 180° per eye';
        texture.setSource(video);
    });
    video.addEventListener('error', () => report(new Error(`Video could not load (${video.error?.message || video.error?.code || 'unknown error'})`)));
    video.addEventListener('play', () => { ui.playback.textContent = 'Pause'; });
    video.addEventListener('pause', () => { ui.playback.textContent = 'Play'; });
    ui.playback.onclick = () => { if (video.paused) void video.play().catch(report); else video.pause(); };
    let yaw = 0;
    let pitch = 0;
    ui.reset.onclick = () => { yaw = pitch = 0; camera.setLocalEulerAngles(0, 0, 0); video.currentTime = 0; };
    const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
    let pointer: number | null = null;
    let x = 0;
    let y = 0;
    canvas.addEventListener('pointerdown', (event) => {
        if (app.xr?.active) return;
        pointer = event.pointerId; x = event.clientX; y = event.clientY; canvas.setPointerCapture(pointer);
    });
    canvas.addEventListener('pointermove', (event) => {
        if (event.pointerId !== pointer) return;
        yaw += (event.clientX - x) * 0.15;
        pitch = Math.max(-85, Math.min(85, pitch + (event.clientY - y) * 0.15));
        x = event.clientX; y = event.clientY; camera.setLocalEulerAngles(pitch, yaw, 0);
    });
    const release = (): void => { pointer = null; };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('lostpointercapture', release);
    let dirty = true;
    if (typeof video.requestVideoFrameCallback === 'function') {
        const frame = (): void => { dirty = true; video.requestVideoFrameCallback(frame); };
        video.requestVideoFrameCallback(frame);
    } else video.addEventListener('timeupdate', () => { dirty = true; });
    app.on('update', () => {
        if (dirty && video.readyState >= 2) { texture.upload(); dirty = false; }
        ui.progress.style.width = video.duration ? `${100 * video.currentTime / video.duration}%` : '0%';
    });
    const xr = app.xr;
    const refreshXr = (): void => {
        material.setParameter('stereoActive', xr?.active ? 1 : 0);
        ui.vr.dataset.available = String(Boolean(xr?.isAvailable('immersive-vr')));
        ui.vr.disabled = !xr?.isAvailable('immersive-vr');
        ui.vr.textContent = xr?.active ? 'Exit VR' : 'Enter VR';
    };
    xr?.on('available:immersive-vr', refreshXr);
    xr?.on('start', refreshXr);
    xr?.on('end', () => { camera.setLocalEulerAngles(pitch, yaw, 0); refreshXr(); });
    ui.vr.onclick = () => {
        if (xr?.active) { xr.end(); return; }
        if (!xr || !camera.camera) return;
        camera.setLocalPosition(0, 0, 0); camera.setLocalEulerAngles(0, 0, 0);
        void video.play().catch(report);
        xr.start(camera.camera, 'immersive-vr', 'local', { callback: (error) => { if (error) report(error); } });
    };
    refreshXr();
    video.src = url;
    video.load();
}
