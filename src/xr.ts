import {
    Color,
    Entity,
    Quat,
    Vec3,
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
    const splatOffsetPos = new Vec3();
    const splatOffsetRot = new Quat();
    const invInputRot = new Quat();
    const targetPos = new Vec3();
    const targetRot = new Quat();
    let targetScale = 1.0;
    let exposure = 0.5;
    let temperature = 0; // Range -10 to +10

    let hudVisible = false;
    let buttonWasPressed = false;
    let resetWasPressed = false;

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
        hudVisible = false;
        hud.enabled = false;
        tintPlane.enabled = true;

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

        // Initialize ALL gsplat entities (for animated splats)
        const gsplatComponents = app.root.findComponents('gsplat');
        for (const comp of gsplatComponents) {
            const splatEntity = comp.entity;
            targetScale = splatEntity.getLocalScale().x;
            splatEntity.setLocalEulerAngles(180, 0, 0);
            splatEntity.setLocalPosition(0, 0, 0);
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
        let anyButtonPressed = false;
        let anyResetPressed = false;
        for (const inputSource of app.xr.input.inputSources) {
            const gripPressed = inputSource.gamepad?.buttons[1]?.pressed; // Grip button
            const triggerPressed = inputSource.gamepad?.buttons[0]?.pressed; // Trigger button
            
            // HUD Toggle (A/B/X/Y buttons)
            const buttonPressed = inputSource.gamepad?.buttons[4]?.pressed || inputSource.gamepad?.buttons[5]?.pressed;
            if (buttonPressed) {
                anyButtonPressed = true;
                if (!buttonWasPressed) {
                    hudVisible = !hudVisible;
                    hud.enabled = hudVisible;
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

            // Grab
            if (!hudVisible && gripPressed && !activeInputSource) {
                activeInputSource = inputSource;
                
                // Calculate offset from controller to splat
                invInputRot.copy(inputSource.getRotation()).invert();
                splatOffsetPos.sub2(splat.getPosition(), inputSource.getPosition());
                invInputRot.transformVector(splatOffsetPos, splatOffsetPos);
                
                splatOffsetRot.mul2(invInputRot, splat.getRotation());
            }

            // Scale
            if (!hudVisible && triggerPressed && !activeScaleSource) {
                activeScaleSource = inputSource;
            }
        }

        // Handle Release
        if (activeInputSource && (!activeInputSource.gamepad?.buttons[1]?.pressed || hudVisible)) {
            activeInputSource = null;
        }
        if (activeScaleSource && (!activeScaleSource.gamepad?.buttons[0]?.pressed || hudVisible)) {
            activeScaleSource = null;
        }

        // Update Splat Position/Rotation - apply to ALL splat entities
        if (activeInputSource) {
            const inputPos = activeInputSource.getPosition();
            const inputRot = activeInputSource.getRotation();

            inputRot.transformVector(splatOffsetPos, targetPos);
            targetPos.add(inputPos);
            targetRot.mul2(inputRot, splatOffsetRot);

            // Smoothing (lerp/slerp) - Higher value = less lag
            const lerpFactor = Math.min(dt * 4.5, 1);
            
            const currentPos = splat.getPosition();
            currentPos.lerp(currentPos, targetPos, lerpFactor);
            
            const currentRot = splat.getRotation();
            currentRot.slerp(currentRot, targetRot, lerpFactor);
            
            // Apply to ALL splat entities so frame switches maintain position
            for (const comp of gsplatComponents) {
                comp.entity.setPosition(currentPos);
                comp.entity.setRotation(currentRot);
            }
        }

        // Update Splat Scale
        if (activeScaleSource) {
            const axes = activeScaleSource.gamepad.axes;
            const y = axes[3] || axes[1] || 0; // Joystick Y

            if (Math.abs(y) > 0.1) {
                targetScale *= (1.0 - y * dt * 0.3); // 0.3 sensitivity
                targetScale = Math.max(0.01, Math.min(targetScale, 100));
            }
        }

        // Apply Scale to ALL splat entities
        for (const comp of gsplatComponents) {
            comp.entity.setLocalScale(targetScale, targetScale, targetScale);
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

        // Apply Scale Directly
        splat.setLocalScale(targetScale, targetScale, targetScale);

        buttonWasPressed = anyButtonPressed;
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
