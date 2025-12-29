import {
    Vec3
} from 'playcanvas';

import { AnimTrack } from '../settings';

/**
 * Creates a small circular "depth" animation track
 *
 * @param position - Starting location of the camera.
 * @param target - Target point the camera is looking at.
 * @param fov - The camera field of view.
 * @param keys - The number of keys in the animation.
 * @param duration - The duration of the animation in seconds.
 * @returns - The animation track object containing position and target keyframes.
 */
const createDepthTrack = (position: Vec3, target: Vec3, fov: number, keys: number = 24, duration: number = 3): AnimTrack => {
    const times = new Array(keys).fill(0).map((_, i) => i / keys * duration);
    const positions: number[] = [];
    const targets: number[] = [];
    const fovs = new Array(keys).fill(fov);

    const dir = new Vec3().sub2(target, position).normalize();
    const up = new Vec3(0, 1, 0);
    const right = new Vec3().cross(dir, up).normalize();
    const actualUp = new Vec3().cross(right, dir).normalize();

    const distance = new Vec3().sub2(target, position).length();
    const radius = distance * 0.02; // 15% of distance for a subtle depth effect

    for (let i = 0; i < keys; ++i) {
        const angle = (i / keys) * Math.PI * 2;
        const offsetX = Math.cos(angle) * radius;
        const offsetY = Math.sin(angle) * radius;

        positions.push(position.x + right.x * offsetX + actualUp.x * offsetY);
        positions.push(position.y + right.y * offsetX + actualUp.y * offsetY);
        positions.push(position.z + right.z * offsetX + actualUp.z * offsetY);

        targets.push(target.x);
        targets.push(target.y);
        targets.push(target.z);
    }

    return {
        name: 'depth',
        duration,
        frameRate: 1,
        loopMode: 'repeat',
        interpolation: 'spline',
        smoothness: 1,
        keyframes: {
            times,
            values: {
                position: positions,
                target: targets,
                fov: fovs
            }
        }
    };
};

export { createDepthTrack };
