import {
    Color,
    Entity,
    Quat,
    Vec3,
    Mat4,
    type CameraComponent,
    StandardMaterial,
    BLEND_NORMAL,
    BLEND_MULTIPLICATIVE,
    TONEMAP_LINEAR,
    Texture,
    FILTER_LINEAR,
    ADDRESS_CLAMP_TO_EDGE,
    STENCILOP_REPLACE,
    FUNC_ALWAYS,
    FUNC_EQUAL,
    STENCILOP_KEEP,
    StencilParameters
} from 'playcanvas';
// playcanvas XR script modules are not used here

import { Global } from './types';

// On entering/exiting AR, we need to set the camera clear color to transparent black
const initXr = (global: Global) => {
    const { app, events, state, camera } = global;

    state.hasAR = app.xr.isAvailable('immersive-ar');
    state.hasVR = app.xr.isAvailable('immersive-vr');

    // initialize ar/vr
    app.xr.on('available:immersive-ar', (available) => {
        state.hasAR = available;
    });
    app.xr.on('available:immersive-vr', (available) => {
        state.hasVR = available;
    });

    const parent = camera.parent as Entity;
    const clearColor = new Color();

    const parentPosition = new Vec3();
    const parentRotation = new Quat();
    const cameraPosition = new Vec3();
    const cameraRotation = new Quat();
    const angles = new Vec3();

    let activeInputSource: any = null;
    let activeScaleSource: any = null;
    let grabbedSplat: Entity | null = null; // The specific splat being grabbed
    const splatOffsetPos = new Vec3();
    const splatOffsetRot = new Quat();
    const invInputRot = new Quat();
    const targetPos = new Vec3();
    const targetRot = new Quat();
    let targetScale = 1.0;
    let exposure = 0.5;
    let temperature = 0; // Range -10 to +10

    // Ray visualization for grab targeting
    const rayLength = 1.5; // meters - short and subtle
    const rayEntities: Map<any, Entity> = new Map();
    let hoveredSplatId: string | null = null; // ID of currently hovered splat
    
    const createRayEntity = (): Entity => {
        const ray = new Entity('grab-ray');
        ray.addComponent('render', { type: 'cylinder' });
        
        const rayMat = new StandardMaterial();
        rayMat.emissive = new Color(0.5, 0.5, 0.5); // Gray default
        rayMat.emissiveIntensity = 1; // Subtle
        rayMat.useLighting = false;
        rayMat.depthTest = false;
        rayMat.depthWrite = false;
        rayMat.blendType = BLEND_NORMAL;
        rayMat.opacity = 0.5; // Semi-transparent
        rayMat.update();
        ray.render.material = rayMat;
        
        // Cylinder: 2mm thick, rayLength long
        ray.setLocalScale(0.002, rayLength / 2, 0.002);
        ray.enabled = false;
        
        app.root.addChild(ray);
        return ray;
    };

    // Store current XRFrame for SteamVR fallback (PlayCanvas doesn't expose it)
    let currentXRFrame: XRFrame | null = null;

    // Hook into the XR session's requestAnimationFrame to capture the frame
    app.xr.on('start', () => {
        const session = (app.xr as any).session as XRSession;
        if (session) {
            const originalRAF = session.requestAnimationFrame.bind(session);
            session.requestAnimationFrame = (callback: XRFrameRequestCallback) => {
                return originalRAF((time: number, frame: XRFrame) => {
                    currentXRFrame = frame;
                    callback(time, frame);
                });
            };
        }
    });
    app.xr.on('end', () => {
        currentXRFrame = null;
    });

    // Helper to get controller world position/rotation from XRInputSource
    // Uses targetRaySpace which is more reliably available than gripSpace
    const getControllerPose = (inputSource: any): { pos: Vec3, rot: Quat } | null => {
        try {
            // First try PlayCanvas methods
            const pos = inputSource.getPosition();
            const rot = inputSource.getRotation();
            if (pos && rot) {
                return { pos, rot };
            }
        } catch (e) {
            // PlayCanvas internal error
        }
        
        // Fallback: access raw WebXR directly using captured frame
        try {
            const xrManager = app.xr as any;
            const session = xrManager?.session as XRSession | null;
            const refSpace = xrManager?._referenceSpace as XRReferenceSpace | null;
            
            if (!session || !currentXRFrame || !refSpace) {
                return null;
            }
            
            // Find matching native input source by comparing gamepad or handedness
            const pcGamepad = inputSource.gamepad;
            let nativeSource: XRInputSource | null = null;
            
            for (const native of session.inputSources) {
                // Match by gamepad reference or handedness
                if (native.gamepad === pcGamepad || 
                    (inputSource.handedness && native.handedness === inputSource.handedness)) {
                    nativeSource = native;
                    break;
                }
            }
            
            if (!nativeSource) {
                // Just use first available
                nativeSource = session.inputSources[0] || null;
            }
            
            if (!nativeSource) {
                return null;
            }
            
            // Try gripSpace first, then targetRaySpace
            const space = nativeSource.gripSpace || nativeSource.targetRaySpace;
            if (!space) {
                return null;
            }
            
            const pose = currentXRFrame.getPose(space, refSpace);
            if (!pose) {
                return null;
            }
            
            const p = pose.transform.position;
            const o = pose.transform.orientation;
            
            return {
                pos: new Vec3(p.x, p.y, p.z),
                rot: new Quat(o.x, o.y, o.z, o.w)
            };
        } catch (e) {
            console.warn('[xr] getControllerPose fallback failed:', e);
            return null;
        }
    };

    let hudVisible = false;
    let hudButtonWasPressed = false;
    let playbackButtonWasPressed = false;
    let resetWasPressed = false;

    // Playback cycle index:
    // 0: pingpong 1x  1: paused  2: loop 1x  3: paused
    // 4: pingpong 2x  5: paused  6: loop 2x  7: paused
    let playbackCycleIndex = 0;
    const PLAYBACK_CYCLE: Array<{ mode: 'pingpong' | 'loop' | 'paused', speed: number, label: string }> = [
        { mode: 'pingpong', speed: 1, label: 'MIRROR 1×' },
        { mode: 'paused',   speed: 1, label: 'PAUSED' },
        { mode: 'loop',     speed: 1, label: 'LOOP 1×' },
        { mode: 'paused',   speed: 1, label: 'PAUSED' },
        { mode: 'pingpong', speed: 2, label: 'MIRROR 2×' },
        { mode: 'paused',   speed: 2, label: 'PAUSED' },
        { mode: 'loop',     speed: 2, label: 'LOOP 2×' },
        { mode: 'paused',   speed: 2, label: 'PAUSED' },
    ];

    const getTempColor = (t: number) => {
        const color = new Color(1, 1, 1); // White at 0
        if (t > 0) {
            // Warmer (Orange)
            color.r = 1.0;
            color.g = 0.6;
            color.b = 0.0;
        } else if (t < 0) {
            // Colder (Blue)
            color.r = 0.0;
            color.g = 0.6;
            color.b = 1.0;
        }
        return color;
    };

    // HUD Setup
    const hud = new Entity('HUD');
    hud.addComponent('render', { type: 'plane' });
    hud.setLocalScale(0.24, 1, 0.12); // 24cm wide, 12cm high (Horizontal)
    hud.setLocalPosition(0.25, 0.15, -1.0); // Back to original offset
    
    const hudMaterial = new StandardMaterial();
    hudMaterial.emissive = new Color(1, 1, 1); // White (will be tinted by texture)
    hudMaterial.useLighting = false;
    hudMaterial.depthTest = false;
    hudMaterial.blendType = BLEND_NORMAL;
    hudMaterial.cull = 0;
    
    // Create Canvas for Text
    const canvas = document.createElement('canvas');
    canvas.width = 512; // Wider canvas
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    
    const hudTexture = new Texture(app.graphicsDevice, {
        width: 512,
        height: 256,
        mipmaps: false,
        minFilter: FILTER_LINEAR,
        magFilter: FILTER_LINEAR,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE
    });
    hudTexture.setSource(canvas);

    const updateHudText = (exp: string, temp: string) => {
        ctx.clearRect(0, 0, 512, 256);
        
        // Background: Solid black
        ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
        ctx.beginPath();
        ctx.roundRect(10, 10, 492, 236, 40);
        ctx.fill();
        
        // Strong White Outline
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 8;
        ctx.stroke();

        // Title
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.textAlign = 'center';
        ctx.font = 'bold 24px Arial';
        ctx.fillText('COLOR CORRECTION', 256, 45);

        // Left Side: Exposure
        ctx.fillStyle = 'white';
        ctx.font = 'bold 80px Arial';
        ctx.fillText(exp, 128, 140);
        ctx.font = 'bold 28px Arial';
        ctx.fillStyle = '#cccccc';
        ctx.fillText('▲ EXP ▼', 128, 190);

        // Right Side: Temperature
        const tVal = parseInt(temp, 10);
        ctx.fillStyle = tVal > 0 ? '#ff9900' : (tVal < 0 ? '#00ccff' : 'white');
        ctx.font = 'bold 80px Arial';
        ctx.fillText(temp, 384, 140);
        ctx.font = 'bold 28px Arial';
        ctx.fillText('◀ TEMP ▶', 384, 190);
        
        hudTexture.upload();
    };

    hudMaterial.emissiveMap = hudTexture;
    hudMaterial.opacityMap = hudTexture; // Use same texture for alpha
    hudMaterial.update();
    hud.render.material = hudMaterial;
    
    updateHudText('0.50', '0');

    // Move HUD to UI layer (rendered after World)
    const uiLayer = app.scene.layers.getLayerByName('UI');
    if (uiLayer) {
        hud.render.layers = [uiLayer.id];
        
        // Ensure camera renders the UI layer
        const cameraLayers = camera.camera.layers;
        if (cameraLayers.indexOf(uiLayer.id) === -1) {
            camera.camera.layers = [...cameraLayers, uiLayer.id];
        }
    }
    
    // Tint Plane Setup (Lens Filter)
    const tintPlane = new Entity('TintPlane');
    tintPlane.addComponent('render', { type: 'plane' });
    tintPlane.setLocalScale(2, 1, 2); // 2m square (should cover most of the view at 0.8m)
    tintPlane.setLocalEulerAngles(90, 0, 0); // Face user
    tintPlane.setLocalPosition(0, 0, -0.8); // Keep the working distance
    
    const tintMaterial = new StandardMaterial();
    tintMaterial.emissive = new Color(1, 1, 1); // White base (neutral for Multiply)
    tintMaterial.opacity = 1.0;
    tintMaterial.useLighting = false;
    tintMaterial.depthTest = false;
    tintMaterial.blendType = BLEND_MULTIPLICATIVE;

    // Stencil: Only render where stencil value is 1 (where splat is)
    tintMaterial.stencilFront = new StencilParameters({
        func: FUNC_EQUAL,
        ref: 1,
        fail: STENCILOP_KEEP,
        zfail: STENCILOP_KEEP,
        zpass: STENCILOP_KEEP
    });
    tintMaterial.stencilBack = tintMaterial.stencilFront;

    tintMaterial.update();
    tintPlane.render.material = tintMaterial;
    
    if (uiLayer) {
        tintPlane.render.layers = [uiLayer.id];
    }
    
    camera.addChild(tintPlane);

    // Attach to camera so it follows head rotation/position
    camera.addChild(hud);

    // XR-only UI: never show in the normal viewer
    hudVisible = false;
    hud.enabled = false;
    tintPlane.enabled = false;

    parent.addComponent('script');
    // parent.script.create(XrControllers);
    // parent.script.create(XrNavigation);

    app.xr.on('start', () => {
        console.log('[ngty-xr.ts] start', {
            xrActive: app.xr.active,
            xrType: app.xr.type,
            xrSession: !!(app.xr as any).session,
            visibility: document.visibilityState
        });
        app.autoRender = true;
        activeInputSource = null;
        activeScaleSource = null;
        grabbedSplat = null;
        playbackCycleIndex = 0; // Reset cycle so it matches initial pingpong 1x state
        hudVisible = false;
        hud.enabled = false;
        tintPlane.enabled = true;

        // Clean up any leftover ray entities from previous sessions
        for (const ray of rayEntities.values()) {
            if (ray) {
                ray.destroy();
            }
        }
        rayEntities.clear();

        // Enable linear tonemapping for exposure to work without shifting colors
        camera.camera.toneMapping = TONEMAP_LINEAR;
        exposure = 0.5; // Default to 0.5 as requested
        (camera.camera as any).exposure = exposure;
        if ((app.scene as any).exposure !== undefined) {
            (app.scene as any).exposure = exposure;
        }
        
        temperature = 0;
        tintMaterial.emissive = new Color(1, 1, 1);
        tintMaterial.update();

        updateHudText(exposure.toFixed(2), '0');

        // cache original camera rig positions and rotations
        parentPosition.copy(parent.getPosition());
        parentRotation.copy(parent.getRotation());
        cameraPosition.copy(camera.getPosition());
        cameraRotation.copy(camera.getRotation());

        cameraRotation.getEulerAngles(angles);

        // copy transform to parent to XR/VR mode starts in the right place
        parent.setPosition(0, 0, 0);
        parent.setEulerAngles(0, 0, 0);

        // Initialize gsplat entities
        // Only reset position for single-splat mode (animated splats)
        // For multi-splat, keep their relative positions
        const splatManager = (global as any).splatManager;
        const isMultiSplat = splatManager && splatManager.count > 1;
        
        const gsplatComponents = app.root.findComponents('gsplat');
        for (const comp of gsplatComponents) {
            const splatEntity = comp.entity;
            targetScale = splatEntity.getLocalScale().x;
            splatEntity.setLocalEulerAngles(180, 0, 0);
            // Only reset position if NOT in multi-splat mode
            if (!isMultiSplat) {
                splatEntity.setLocalPosition(0, 0, 0);
            }
        }

        if (app.xr.type === 'immersive-ar') {
            clearColor.copy(camera.camera.clearColor);
            camera.camera.clearColor = new Color(0, 0, 0, 0);
        }
    });

    app.xr.on('end', () => {
        console.log('[ngty-xr.ts] end', {
            xrActive: app.xr.active,
            xrType: app.xr.type,
            xrSession: !!(app.xr as any).session,
            visibility: document.visibilityState
        });
        app.autoRender = false;
        activeInputSource = null;
        hudVisible = false;
        hud.enabled = false;
        tintPlane.enabled = false;

        // Clean up ray entities
        for (const ray of rayEntities.values()) {
            if (ray) {
                ray.destroy();
            }
        }
        rayEntities.clear();

        // restore camera to pre-XR state
        parent.setPosition(parentPosition);
        parent.setRotation(parentRotation);
        camera.setPosition(cameraPosition);
        camera.setRotation(cameraRotation);

        if (app.xr.type === 'immersive-ar') {
            camera.camera.clearColor = clearColor;
        }
    });

    app.on('update', (dt) => {
        if (!app.xr.active) return;

        // Clean up stale ray entities (from disconnected controllers / Quest menu)
        const currentInputSources = new Set(app.xr.input.inputSources);
        for (const [inputSource, ray] of rayEntities.entries()) {
            if (!currentInputSources.has(inputSource)) {
                if (ray) ray.destroy();
                rayEntities.delete(inputSource);
            }
        }

        // Update splat markers to follow their entities
        const splatManager = (global as any).splatManager;
        if (splatManager && typeof splatManager.updateMarkers === 'function') {
            splatManager.updateMarkers();
        }

        // Find ALL gsplat entities (for animated splats there are multiple frames)
        const gsplatComponents = app.root.findComponents('gsplat');
        if (!gsplatComponents || gsplatComponents.length === 0) return;
        
        // Get the currently enabled splat entity (the visible frame)
        let splat: Entity | null = null;
        for (const comp of gsplatComponents) {
            if (comp.entity.enabled) {
                splat = comp.entity;
                break;
            }
        }
        if (!splat) {
            // Fallback to first one if none enabled
            splat = gsplatComponents[0].entity;
        }

        // Ensure ALL splats have stencil set up (so they work when their frame is shown)
        for (const comp of gsplatComponents) {
            const gsplat = (comp.entity as any).gsplat;
            if (gsplat && gsplat.instance && gsplat.instance.meshInstance) {
                const mi = gsplat.instance.meshInstance;
                if (!mi.stencilFront || mi.stencilFront.func !== FUNC_ALWAYS) {
                    mi.stencilFront = new StencilParameters({
                        func: FUNC_ALWAYS,
                        ref: 1,
                        fail: STENCILOP_REPLACE,
                        zfail: STENCILOP_REPLACE,
                        zpass: STENCILOP_REPLACE
                    });
                    mi.stencilBack = mi.stencilFront;
                }
            }
        }

        // Dynamically orient HUD to face the camera
        if (hudVisible) {
            hud.lookAt(camera.getPosition());
            hud.rotateLocal(90, 180, 0); // Flip 180 to face the user
        }

        // Handle Grip/Trigger Start
        let anyHudButtonPressed = false;
        let anyPlaybackButtonPressed = false;
        let anyResetPressed = false;
        for (const inputSource of app.xr.input.inputSources) {
            const gripPressed = inputSource.gamepad?.buttons[1]?.pressed; // Grip button
            const triggerPressed = inputSource.gamepad?.buttons[0]?.pressed; // Trigger button
            
            // HUD Toggle (A or X buttons - button 4)
            const hudButtonPressed = inputSource.gamepad?.buttons[4]?.pressed;
            if (hudButtonPressed) {
                anyHudButtonPressed = true;
                if (!hudButtonWasPressed) {
                    hudVisible = !hudVisible;
                    hud.enabled = hudVisible;
                }
            }
            
            // Playback Mode Cycle (B or Y buttons - button 5)
            // Cycle: mirror 1x -> paused -> loop 1x -> paused -> mirror 2x -> paused -> loop 2x -> paused -> ...
            const playbackButtonPressed = inputSource.gamepad?.buttons[5]?.pressed;
            if (playbackButtonPressed) {
                anyPlaybackButtonPressed = true;
                if (!playbackButtonWasPressed && state.hasSplatAnimation) {
                    playbackCycleIndex = (playbackCycleIndex + 1) % PLAYBACK_CYCLE.length;
                    const next = PLAYBACK_CYCLE[playbackCycleIndex];
                    state.splatAnimationMode = next.mode;
                    state.splatAnimationSpeed = next.speed;
                    console.log(`[xr] Playback: ${next.label}`);
                }
            }

            // Joystick Click Reset (Button 3)
            const resetPressed = inputSource.gamepad?.buttons[3]?.pressed;
            if (resetPressed && hudVisible) {
                anyResetPressed = true;
                if (!resetWasPressed) {
                    exposure = 0.5;
                    temperature = 0;
                    
                    // Apply Exposure
                    (camera.camera as any).exposure = exposure;
                    if ((app.scene as any).exposure !== undefined) {
                        (app.scene as any).exposure = exposure;
                    }

                    // Apply Temperature
                    tintMaterial.emissive = new Color(1, 1, 1);
                    tintMaterial.update();

                    updateHudText('0.50', '0');
                }
            }

            // Grab - use raycast to find first splat the ray touches
            if (!hudVisible && gripPressed && !activeInputSource) {
                const pose = getControllerPose(inputSource);
                
                if (pose) {
                    // Get ray direction - SAME as visual ray: -Y angled 45 degrees towards -Z
                    const rayDir = new Vec3(0, -0.707, -0.707);
                    pose.rot.transformVector(rayDir, rayDir);
                    rayDir.normalize();
                    
                    console.log(`[XR GRAB] Controller pos: (${pose.pos.x.toFixed(2)}, ${pose.pos.y.toFixed(2)}, ${pose.pos.z.toFixed(2)})`);
                    console.log(`[XR GRAB] Ray direction: (${rayDir.x.toFixed(2)}, ${rayDir.y.toFixed(2)}, ${rayDir.z.toFixed(2)})`);
                    
                    // Find splat by ray
                    const splatManager = (global as any).splatManager;
                    let targetSplat: Entity | null = null;
                    
                    if (splatManager && typeof splatManager.findSplatByRay === 'function') {
                        const hitInstance = splatManager.findSplatByRay(pose.pos, rayDir);
                        targetSplat = hitInstance?.entity || null;
                        console.log(`[XR GRAB] Raycast result: ${hitInstance?.id || 'none'}`);
                    }
                    
                    // Fallback to current visible splat if no splatManager or no hit
                    if (!targetSplat) {
                        console.log(`[XR GRAB] No raycast hit, falling back to first splat`);
                        targetSplat = splat;
                    }
                    
                    if (targetSplat) {
                        activeInputSource = inputSource;
                        grabbedSplat = targetSplat;
                        
                        // Hide ray when grabbing
                        const ray = rayEntities.get(inputSource);
                        if (ray) ray.enabled = false;
                        
                        // Calculate offset from controller to the grabbed splat
                        invInputRot.copy(pose.rot).invert();
                        splatOffsetPos.sub2(targetSplat.getPosition(), pose.pos);
                        invInputRot.transformVector(splatOffsetPos, splatOffsetPos);
                        
                        splatOffsetRot.mul2(invInputRot, targetSplat.getRotation());
                    }
                }
            }
            
            // Show ray when not grabbing (for aiming)
            if (!activeInputSource && !hudVisible) {
                const pose = getControllerPose(inputSource);
                if (pose) {
                    // Get or create ray entity for this controller
                    let ray = rayEntities.get(inputSource);
                    if (!ray) {
                        ray = createRayEntity();
                        rayEntities.set(inputSource, ray);
                    }
                    
                    ray.enabled = true;
                    
                    // Controller forward: -Y angled 45 degrees towards -Z
                    const forward = new Vec3(0, -0.707, -0.707);
                    pose.rot.transformVector(forward, forward);
                    forward.normalize();
                    
                    // Position ray: cylinder center is at halfLength forward from controller
                    const halfLength = rayLength / 2;
                    ray.setPosition(
                        pose.pos.x + forward.x * halfLength,
                        pose.pos.y + forward.y * halfLength,
                        pose.pos.z + forward.z * halfLength
                    );
                    
                    // Build rotation: cylinder Y axis should point along 'forward'
                    const yAxis = new Vec3(0, 1, 0);
                    const dot = yAxis.dot(forward);
                    
                    if (dot > 0.9999) {
                        ray.setRotation(Quat.IDENTITY);
                    } else if (dot < -0.9999) {
                        ray.setRotation(new Quat().setFromAxisAngle(Vec3.RIGHT, 180));
                    } else {
                        const axis = new Vec3().cross(yAxis, forward).normalize();
                        const angle = Math.acos(dot) * (180 / Math.PI);
                        ray.setRotation(new Quat().setFromAxisAngle(axis, angle));
                    }
                    
                    // Raycast to find hovered splat - use marker spheres
                    const splatManager = (global as any).splatManager;
                    const rayMat = ray.render?.material as StandardMaterial;
                    
                    if (splatManager && typeof splatManager.findSplatByRay === 'function') {
                        const hitInstance = splatManager.findSplatByRay(pose.pos, forward);
                        hoveredSplatId = hitInstance?.id || null;
                        
                        // Color ray to match the hovered splat's marker color
                        if (rayMat) {
                            if (hitInstance) {
                                rayMat.emissive = hitInstance.color;
                            } else {
                                rayMat.emissive = new Color(0.3, 0.3, 0.3); // Gray when not targeting
                            }
                            rayMat.update();
                        }
                    }
                }
            } else {
                // Hide ray for this controller if grabbing or HUD visible
                const ray = rayEntities.get(inputSource);
                if (ray) ray.enabled = false;
                hoveredSplatId = null;
            }

            // Scale
            if (!hudVisible && triggerPressed && !activeScaleSource) {
                activeScaleSource = inputSource;
            }
        }

        // Handle Release
        if (activeInputSource && (!activeInputSource.gamepad?.buttons[1]?.pressed || hudVisible)) {
            activeInputSource = null;
            grabbedSplat = null;
        }
        if (activeScaleSource && (!activeScaleSource.gamepad?.buttons[0]?.pressed || hudVisible)) {
            activeScaleSource = null;
        }

        // Update Splat Position/Rotation - apply only to grabbed splat
        if (activeInputSource && grabbedSplat) {
            const pose = getControllerPose(activeInputSource);

            // No pose? Skip this frame
            if (!pose) {
                // Don't release, just skip - might recover next frame
            } else {
                pose.rot.transformVector(splatOffsetPos, targetPos);
                targetPos.add(pose.pos);
                targetRot.mul2(pose.rot, splatOffsetRot);

                // Smoothing (lerp/slerp) - Higher value = less lag
                const lerpFactor = Math.min(dt * 4.5, 1);
                
                const currentPos = grabbedSplat.getPosition();
                currentPos.lerp(currentPos, targetPos, lerpFactor);
                
                const currentRot = grabbedSplat.getRotation();
                currentRot.slerp(currentRot, targetRot, lerpFactor);
                
                // Apply only to grabbed splat (and its animation frames if animated)
                // For animated splats, we need to move ALL frames together
                // But for multi-splat mode, only move the specific grabbed splat
                const splatManager = (global as any).splatManager;
                const isMultiSplat = splatManager && splatManager.count > 1;
                
                if (!isMultiSplat && gsplatComponents.length > 1) {
                    // Animated splat (single logical splat with multiple frame entities)
                    // Move all frame entities together
                    for (const comp of gsplatComponents) {
                        comp.entity.setPosition(currentPos);
                        comp.entity.setRotation(currentRot);
                    }
                } else {
                    // Multi-splat mode OR single splat - only move the grabbed one
                    grabbedSplat.setPosition(currentPos);
                    grabbedSplat.setRotation(currentRot);
                }
            }
        }

        // Update Splat Scale - only while grabbing (grip + trigger)
        if (activeScaleSource && grabbedSplat) {
            const axes = activeScaleSource.gamepad.axes;
            const y = axes[3] || axes[1] || 0; // Joystick Y

            if (Math.abs(y) > 0.1) {
                // Get current scale of grabbed splat
                const currentScale = grabbedSplat.getLocalScale().x;
                const newScale = currentScale * (1.0 - y * dt * 0.3); // 0.3 sensitivity
                const clampedScale = Math.max(0.01, Math.min(newScale, 100));
                
                // Apply scale only to grabbed splat (or all frames for animated)
                const splatManager = (global as any).splatManager;
                const isMultiSplat = splatManager && splatManager.count > 1;
                
                if (!isMultiSplat && gsplatComponents.length > 1) {
                    // Animated splat - apply to all frames
                    for (const comp of gsplatComponents) {
                        comp.entity.setLocalScale(clampedScale, clampedScale, clampedScale);
                    }
                } else {
                    // Multi-splat or single splat
                    grabbedSplat.setLocalScale(clampedScale, clampedScale, clampedScale);
                }
            }
        }

        // Update Exposure (when HUD is visible)
        if (hudVisible) {
            for (const inputSource of app.xr.input.inputSources) {
                const axes = inputSource.gamepad?.axes;
                if (!axes) continue;
                
                const y = axes[3] || axes[1] || 0; // Joystick Y
                const x = axes[2] || axes[0] || 0; // Joystick X

                let changed = false;

                // Only adjust the dominant axis to prevent diagonal changes
                if (Math.abs(y) > Math.abs(x)) {
                    if (Math.abs(y) > 0.1) {
                        // Adjust exposure: Up = brighter, Down = darker
                        exposure *= (1.0 - y * dt * 1); // 1.0 sensitivity
                        exposure = Math.max(0.1, Math.min(exposure, 3.0));
                        
                        // Apply to camera and scene
                        (camera.camera as any).exposure = exposure;
                        if ((app.scene as any).exposure !== undefined) {
                            (app.scene as any).exposure = exposure;
                        }
                        changed = true;
                    }
                } else {
                    if (Math.abs(x) > 0.1) {
                        // Adjust temperature: -10 to +10, fast rate of change
                        temperature += x * dt * 10.0;
                        temperature = Math.max(-10, Math.min(temperature, 10));
                        
                        const targetTint = getTempColor(temperature);
                        // Multiply mode: Lerp from White (no effect) to target color
                        const intensity = (Math.abs(temperature) / 10) * 0.4;
                        tintMaterial.emissive.lerp(Color.WHITE, targetTint, intensity);
                        tintMaterial.update();
                        
                        changed = true;
                    }
                }

                if (changed) {
                    updateHudText(exposure.toFixed(2), Math.round(temperature).toString());
                }
            }
        }

        hudButtonWasPressed = anyHudButtonPressed;
        playbackButtonWasPressed = anyPlaybackButtonPressed;
        resetWasPressed = anyResetPressed;
    });

    events.on('startAR', () => {
        app.xr.start(app.root.findComponent('camera') as CameraComponent, 'immersive-ar', 'local');
    });

    events.on('startVR', () => {
        app.xr.start(app.root.findComponent('camera') as CameraComponent, 'immersive-vr', 'local');
    });

    events.on('inputEvent', (event) => {
        if (event === 'cancel' && app.xr.active) {
            app.xr.end();
        }
    });
};

export { initXr };
