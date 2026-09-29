import { Entity, Quat, Vec3, type AppBase } from 'playcanvas';

export function desktopNavigation(app: AppBase, camera: Entity, content: Entity, pivot?: [number, number, number]): () => void {
    const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
    canvas.style.touchAction = 'none';
    const target = new Vec3();
    const desired = new Entity();
    const position = new Vec3(), rotation = new Quat();
    let drag: { id: number; x: number; y: number; pan: boolean } | null = null;
    const reset = (): void => {
        drag = null;
        desired.setPosition(camera.getPosition()); desired.setRotation(camera.getRotation());
        if (pivot) content.getWorldTransform().transformPoint(new Vec3(...pivot), target);
        else target.copy(camera.getPosition()).add(camera.forward.clone());
    };
    const active = (): boolean => !app.xr?.active;
    app.on('update', (dt: number) => {
        if (!active()) return;
        const amount = 1 - Math.exp(-dt / 0.065);
        camera.setPosition(position.lerp(camera.getPosition(), desired.getPosition(), amount));
        camera.setRotation(rotation.slerp(camera.getRotation(), desired.getRotation(), amount));
    });
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    canvas.addEventListener('pointerdown', event => {
        if (!active() || drag) return;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.button !== 0 || event.shiftKey };
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
    });
    canvas.addEventListener('pointermove', event => {
        if (!active() || !drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        drag.x = event.clientX; drag.y = event.clientY;
        const offset = desired.getPosition().clone().sub(target);
        const distance = Math.max(0.02, offset.length());
        if (drag.pan) {
            const scale = 2 * distance * Math.tan((camera.camera?.fov || 60) * Math.PI / 360) / canvas.clientHeight;
            const shift = desired.right.clone().mulScalar(-dx * scale).add(desired.up.clone().mulScalar(dy * scale));
            target.add(shift); desired.setPosition(desired.getPosition().clone().add(shift));
        } else {
            const yaw = Math.atan2(offset.x, offset.z) - dx * 0.005;
            const pitch = Math.max(-1.55, Math.min(1.55, Math.asin(offset.y / distance) + dy * 0.005));
            desired.setPosition(target.clone().add(new Vec3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).mulScalar(distance)));
            desired.lookAt(target);
        }
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, () => { drag = null; });
    canvas.addEventListener('wheel', event => {
        if (!active()) return;
        event.preventDefault();
        const offset = desired.getPosition().clone().sub(target);
        const distance = Math.max(0.02, Math.min(1000, offset.length() * Math.exp(Math.max(-200, Math.min(200, event.deltaY)) * 0.002)));
        desired.setPosition(target.clone().add(offset.normalize().mulScalar(distance)));
    }, { passive: false });
    app.xr?.on('start', () => { drag = null; });
    reset();
    return reset;
}
