import {
    ADDRESS_CLAMP_TO_EDGE,
    BLEND_NORMAL,
    Color,
    CULLFACE_NONE,
    Entity,
    FILTER_LINEAR,
    StandardMaterial,
    Texture,
    type AppBase
} from 'playcanvas';

const WIDTH = 1024;
const HEIGHT = 512;

export class XrStatsOverlay {
    private readonly entity: Entity;
    private readonly canvas: HTMLCanvasElement;
    private readonly context: CanvasRenderingContext2D;
    private readonly texture: Texture;
    private readonly material: StandardMaterial;
    private lastText = '';

    constructor(app: AppBase, camera: Entity) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = WIDTH;
        this.canvas.height = HEIGHT;
        const context = this.canvas.getContext('2d', { alpha: true });
        if (!context) throw new Error('Canvas 2D is unavailable for the XR diagnostics overlay.');
        this.context = context;

        this.texture = new Texture(app.graphicsDevice, {
            name: 'ems-xr-stats',
            width: WIDTH,
            height: HEIGHT,
            mipmaps: false,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.texture.setSource(this.canvas);

        this.material = new StandardMaterial();
        this.material.name = 'ems-xr-stats-material';
        this.material.useLighting = false;
        this.material.diffuse = Color.BLACK;
        this.material.emissive = Color.WHITE;
        this.material.emissiveMap = this.texture;
        this.material.opacityMap = this.texture;
        this.material.opacityMapChannel = 'a';
        this.material.blendType = BLEND_NORMAL;
        this.material.depthTest = false;
        this.material.depthWrite = false;
        this.material.cull = CULLFACE_NONE;
        this.material.update();

        this.entity = new Entity('xr-stats-overlay');
        this.entity.addComponent('render', { type: 'plane' });
        if (this.entity.render) {
            this.entity.render.material = this.material;
            this.entity.render.castShadows = false;
            this.entity.render.receiveShadows = false;
        }
        // The PlayCanvas plane faces +Y. Rotate it toward the -Z-facing camera
        // and keep it low enough that it does not cover the subject.
        this.entity.setLocalEulerAngles(90, 0, 0);
        this.entity.setLocalPosition(0, -0.25, -0.9);
        this.entity.setLocalScale(0.92, 1, 0.46);
        this.entity.enabled = false;
        camera.addChild(this.entity);
        this.update(['EMS XR diagnostics', 'Waiting for an immersive session…']);
    }

    get visible(): boolean {
        return this.entity.enabled;
    }

    set visible(value: boolean) {
        this.entity.enabled = value;
    }

    toggle(): boolean {
        this.visible = !this.visible;
        return this.visible;
    }

    update(lines: string[]): void {
        const text = lines.join('\n');
        if (text === this.lastText) return;
        this.lastText = text;
        const ctx = this.context;
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        ctx.fillStyle = 'rgba(5, 8, 13, 0.88)';
        ctx.beginPath();
        ctx.roundRect(0, 0, WIDTH, HEIGHT, 34);
        ctx.fill();
        ctx.strokeStyle = 'rgba(230, 106, 153, 0.78)';
        ctx.lineWidth = 4;
        ctx.stroke();

        ctx.fillStyle = '#e66a99';
        ctx.font = '700 38px system-ui, sans-serif';
        ctx.fillText(lines[0] || 'EMS XR diagnostics', 48, 62);
        ctx.font = '600 27px ui-monospace, SFMono-Regular, Consolas, monospace';
        ctx.textBaseline = 'top';
        let y = 92;
        for (const line of lines.slice(1, 12)) {
            ctx.fillStyle = line.startsWith('QUALITY') ? '#8bd8b4' : '#eef2f7';
            ctx.fillText(line, 48, y);
            y += 35;
        }
        ctx.fillStyle = '#99a3b3';
        ctx.font = '500 23px system-ui, sans-serif';
        ctx.fillText('A/X: stats · grip: move · + trigger + stick up/down: scale', 48, HEIGHT - 45);
        this.texture.setSource(this.canvas);
    }

    destroy(): void {
        this.entity.destroy();
        this.material.destroy();
        this.texture.destroy();
    }
}
