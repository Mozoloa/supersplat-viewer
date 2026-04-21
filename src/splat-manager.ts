import { Entity, Asset, BoundingBox, Vec3, Color, StandardMaterial, BLEND_NORMAL } from 'playcanvas';

import { loadGsplat } from './gsplat-loader';
import { Config, Global } from './types';

// Predefined colors for splat markers
const SPLAT_COLORS = [
    new Color(1, 0.3, 0.3),    // Red
    new Color(0.3, 1, 0.3),    // Green
    new Color(0.3, 0.6, 1),    // Blue
    new Color(1, 1, 0.3),      // Yellow
    new Color(1, 0.3, 1),      // Magenta
    new Color(0.3, 1, 1),      // Cyan
    new Color(1, 0.6, 0.3),    // Orange
    new Color(0.6, 0.3, 1)     // Purple
];

export interface SplatInstance {
    id: string;
    entity: Entity;
    asset: Asset | null;
    url: string;
    selected: boolean;
    bounds: BoundingBox;
    marker: Entity;      // Visible sphere at centroid
    color: Color;        // Unique color for this splat
    grabRadius: number;  // Radius for grab detection
    centroid: Vec3;      // Center of mass offset from entity origin
}

/**
 * Manages multiple splat entities in the scene.
 * Supports adding, removing, selecting, and transforming individual splats.
 */
export class SplatManager {
    private global: Global;

    private splats: Map<string, SplatInstance> = new Map();

    private selectedId: string | null = null;

    private container: Entity;

    private colorIndex = 0;

    constructor(global: Global) {
        this.global = global;

        // Create container entity for all splats
        this.container = new Entity('splats-container');
        global.app.root.addChild(this.container);
    }

    private getNextColor(): Color {
        const color = SPLAT_COLORS[this.colorIndex % SPLAT_COLORS.length];
        this.colorIndex++;
        return color.clone();
    }

    private createMarker(color: Color, radius: number): Entity {
        const { app } = this.global;
        const marker = new Entity('splat-marker');
        marker.addComponent('render', { type: 'sphere' });
        marker.setLocalScale(radius * 2, radius * 2, radius * 2); // diameter = radius * 2
        
        const mat = new StandardMaterial();
        mat.emissive = color;
        mat.emissiveIntensity = 1;
        mat.useLighting = false;
        mat.opacity = 0; // Invisible
        mat.blendType = BLEND_NORMAL;
        mat.depthWrite = false;
        mat.update();
        marker.render.material = mat;
        
        app.root.addChild(marker);
        return marker;
    }

    private generateId(url: string): string {
        // Extract filename without extension, add timestamp for uniqueness
        const filename = url.split('/').pop()?.split('?')[0] || 'splat';
        const base = filename.replace(/\.(ply|splat|splatseq)$/i, '');
        const timestamp = Date.now().toString(36);
        return `${base}_${timestamp}`;
    }

    /**
     * Register an existing entity that was already loaded (e.g., primary splat)
     */
    registerExistingEntity(entity: Entity, url: string): SplatInstance {
        const id = this.generateId(url || 'primary-splat');
        
        // Move to container if not already there
        if (entity.parent !== this.container) {
            entity.parent?.removeChild(entity);
            this.container.addChild(entity);
        }

        // Get asset reference
        const gsplatComponent = (entity as any).gsplat;
        const asset = gsplatComponent?.asset || null;

        // Get centroid from bounding box
        const bounds = new BoundingBox();
        let centroid = new Vec3(0, 0, 0);
        
        const gsplatInstance = gsplatComponent?.instance;
        if (gsplatInstance) {
            const meshInstance = gsplatInstance.meshInstance;
            const resource = gsplatInstance.resource;
            
            // Try to compute centroid from decompressed centers
            if (resource?.centers && resource.centers.length >= 3) {
                const centers = resource.centers;
                const numSplats = centers.length / 3;
                
                // Extract x, y, z arrays
                const xs: number[] = [];
                const ys: number[] = [];
                const zs: number[] = [];
                for (let i = 0; i < numSplats; i++) {
                    xs.push(centers[i * 3]);
                    ys.push(centers[i * 3 + 1]);
                    zs.push(centers[i * 3 + 2]);
                }
                
                // Compute median (robust to outliers)
                xs.sort((a, b) => a - b);
                ys.sort((a, b) => a - b);
                zs.sort((a, b) => a - b);
                const mid = Math.floor(numSplats / 2);
                centroid.set(xs[mid], ys[mid], zs[mid]);
                console.log(`[SplatManager] ${id} median from ${numSplats} centers: (${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)}, ${centroid.z.toFixed(2)})`);
            } else if (meshInstance?.aabb) {
                // Fallback to aabb center
                bounds.copy(meshInstance.aabb);
                centroid = bounds.center.clone();
                console.log(`[SplatManager] ${id} fallback aabb center: (${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)}, ${centroid.z.toFixed(2)})`);
            }
            
            if (meshInstance?.aabb) {
                bounds.copy(meshInstance.aabb);
            }
        } else {
            console.log(`[SplatManager] ${id} NO gsplatInstance!`);
        }

        // Create marker at centroid
        const color = this.getNextColor();
        const grabRadius = 0.3; // 30cm grab radius
        const marker = this.createMarker(color, 0.1); // 10cm visual sphere
        
        // aabb.center is already in world space
        marker.setPosition(centroid);
        console.log(`[SplatManager] ${id} marker at: (${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)}, ${centroid.z.toFixed(2)})`);

        const instance: SplatInstance = {
            id,
            entity,
            asset,
            url: url || '',
            selected: false,
            bounds,
            marker,
            color,
            grabRadius,
            centroid
        };

        this.splats.set(id, instance);

        if (this.splats.size === 1) {
            this.selectSplat(id);
        }

        console.log(`[SplatManager] Registered existing splat: ${id} (total: ${this.splats.size})`);

        return instance;
    }

    async addSplat(
        url: string,
        progressCallback?: (progress: number) => void
    ): Promise<SplatInstance | null> {
        const { app, config } = this.global;
        
        const id = this.generateId(url);

        try {
            // Create a temporary config for loading
            const loadConfig: Config = {
                ...config,
                contentUrl: url,
                contents: fetch(url)
            };

            // Load the splat entity
            const entity = await loadGsplat(app, loadConfig, progressCallback || (() => {}));

            if (!entity) {
                console.error('[SplatManager] Failed to load splat:', url);
                return null;
            }

            // Remove from root (loadGsplat adds it there) and add to our container
            app.root.removeChild(entity);
            this.container.addChild(entity);

            // Offset position based on existing splat count (so they don't all overlap)
            const offset = this.splats.size * 0.5; // 50cm apart
            entity.setLocalPosition(offset, 0, 0);

            // Get the asset reference
            const gsplatComponent = (entity as any).gsplat;
            const asset = gsplatComponent?.asset || null;

            // Calculate centroid from decompressed centers (robust median)
            const bounds = new BoundingBox();
            let centroid = new Vec3(0, 0, 0);
            
            const gsplatInstance = gsplatComponent?.instance;
            if (gsplatInstance) {
                const meshInstance = gsplatInstance.meshInstance;
                const resource = gsplatInstance.resource;
                
                // Try to compute centroid from decompressed centers
                if (resource?.centers && resource.centers.length >= 3) {
                    const centers = resource.centers;
                    const numSplats = centers.length / 3;
                    
                    const xs: number[] = [];
                    const ys: number[] = [];
                    const zs: number[] = [];
                    for (let i = 0; i < numSplats; i++) {
                        xs.push(centers[i * 3]);
                        ys.push(centers[i * 3 + 1]);
                        zs.push(centers[i * 3 + 2]);
                    }
                    
                    xs.sort((a, b) => a - b);
                    ys.sort((a, b) => a - b);
                    zs.sort((a, b) => a - b);
                    const mid = Math.floor(numSplats / 2);
                    centroid.set(xs[mid], ys[mid], zs[mid]);
                    console.log(`[SplatManager] ${id} median from ${numSplats} centers: (${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)}, ${centroid.z.toFixed(2)})`);
                } else if (meshInstance?.aabb) {
                    bounds.copy(meshInstance.aabb);
                    centroid = bounds.center.clone();
                    console.log(`[SplatManager] ${id} fallback aabb center: (${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)}, ${centroid.z.toFixed(2)})`);
                }
                
                if (meshInstance?.aabb) {
                    bounds.copy(meshInstance.aabb);
                }
            }

            // Create marker at centroid
            const color = this.getNextColor();
            const grabRadius = 0.3; // 30cm grab radius
            const marker = this.createMarker(color, 0.1); // 10cm visual sphere
            
            // centroid is already in world space
            marker.setPosition(centroid);
            console.log(`[SplatManager] ${id} marker at: (${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)}, ${centroid.z.toFixed(2)})`);

            // Create instance record
            const instance: SplatInstance = {
                id,
                entity,
                asset,
                url,
                selected: false,
                bounds,
                marker,
                color,
                grabRadius,
                centroid
            };

            this.splats.set(id, instance);

            // Auto-select if it's the only splat
            if (this.splats.size === 1) {
                this.selectSplat(id);
            }

            console.log(`[SplatManager] Added splat: ${id} (total: ${this.splats.size})`);

            return instance;
        } catch (error) {
            console.error('[SplatManager] Error adding splat:', error);
            return null;
        }
    }

    removeSplat(id: string): boolean {
        const instance = this.splats.get(id);
        if (!instance) return false;

        // Destroy entity and marker
        if (instance.entity) {
            instance.entity.destroy();
        }
        if (instance.marker) {
            instance.marker.destroy();
        }
        
        // Unload and remove asset (if exists and has unload method)
        if (instance.asset && typeof instance.asset.unload === 'function') {
            try {
                instance.asset.unload();
                this.global.app.assets.remove(instance.asset);
            } catch (e) {
                console.warn(`[SplatManager] Failed to unload asset for ${id}:`, e);
            }
        }

        this.splats.delete(id);

        // If removed splat was selected, select another
        if (this.selectedId === id) {
            this.selectedId = null;
            const firstSplat = this.splats.keys().next().value;
            if (firstSplat) {
                this.selectSplat(firstSplat);
            }
        }

        console.log(`[SplatManager] Removed splat: ${id} (remaining: ${this.splats.size})`);
        return true;
    }

    clear(): void {
        // Collect IDs first to avoid modifying map while iterating
        const ids = Array.from(this.splats.keys());
        for (const id of ids) {
            this.removeSplat(id);
        }
        this.selectedId = null;
    }

    selectSplat(id: string): boolean {
        const instance = this.splats.get(id);
        if (!instance) return false;

        // Deselect previous
        if (this.selectedId && this.selectedId !== id) {
            const prev = this.splats.get(this.selectedId);
            if (prev) prev.selected = false;
        }

        instance.selected = true;
        this.selectedId = id;

        console.log(`[SplatManager] Selected: ${id}`);
        return true;
    }

    getSelectedSplat(): SplatInstance | null {
        if (!this.selectedId) return null;
        return this.splats.get(this.selectedId) || null;
    }

    getAllSplats(): SplatInstance[] {
        return Array.from(this.splats.values());
    }

    get count(): number {
        return this.splats.size;
    }

    getContainer(): Entity {
        return this.container;
    }

    findClosestSplat(worldPos: Vec3): SplatInstance | null {
        let closest: SplatInstance | null = null;
        let closestDist = Infinity;

        console.log(`[SplatManager] findClosestSplat from: ${worldPos.x.toFixed(2)}, ${worldPos.y.toFixed(2)}, ${worldPos.z.toFixed(2)}`);
        
        for (const instance of this.splats.values()) {
            const splatPos = instance.entity.getPosition();
            const dist = splatPos.distance(worldPos);
            
            console.log(`[SplatManager]   - ${instance.id}: pos(${splatPos.x.toFixed(2)}, ${splatPos.y.toFixed(2)}, ${splatPos.z.toFixed(2)}) dist=${dist.toFixed(2)}`);

            if (dist < closestDist) {
                closestDist = dist;
                closest = instance;
            }
        }
        
        console.log(`[SplatManager] Closest: ${closest?.id || 'none'} at dist=${closestDist.toFixed(2)}`);

        return closest;
    }

    findSplatByRay(rayOrigin: Vec3, rayDir: Vec3): SplatInstance | null {
        let closest: SplatInstance | null = null;
        let closestT = Infinity;

        // Normalize ray direction
        const dir = new Vec3().copy(rayDir).normalize();

        for (const instance of this.splats.values()) {
            // Use marker position as the grab target center
            const markerPos = instance.marker.getPosition();
            const radius = instance.grabRadius;

            // Ray-sphere intersection against the marker sphere
            const oc = new Vec3().sub2(rayOrigin, markerPos);
            const a = dir.dot(dir);
            const b = 2.0 * oc.dot(dir);
            const c = oc.dot(oc) - radius * radius;
            const discriminant = b * b - 4 * a * c;

            if (discriminant >= 0) {
                const sqrtD = Math.sqrt(discriminant);
                const t1 = (-b - sqrtD) / (2.0 * a);
                const t2 = (-b + sqrtD) / (2.0 * a);
                
                // Use t1 if positive (outside sphere), otherwise t2 if pointing towards center
                let t = -1;
                if (t1 > 0) {
                    t = t1;
                } else if (t2 > 0 && oc.dot(dir) < 0) {
                    t = t2;
                }
                
                if (t > 0 && t < closestT) {
                    closestT = t;
                    closest = instance;
                }
            }
        }

        return closest;
    }

    /**
     * Update marker positions to follow their splat entities.
     * Call this every frame during XR.
     */
    updateMarkers(): void {
        for (const instance of this.splats.values()) {
            // Transform centroid from local to world space
            const worldCentroid = instance.entity.getLocalTransform().transformPoint(instance.centroid.clone());
            instance.marker.setPosition(worldCentroid);
        }
    }

    /**
     * Get the color for a splat instance (for ray coloring)
     */
    getSplatColor(id: string): Color | null {
        return this.splats.get(id)?.color || null;
    }

    applyXRTransforms(): void {
        for (const instance of this.splats.values()) {
            instance.entity.setLocalPosition(0, 0, 0);
        }
    }

    getCombinedBounds(): BoundingBox {
        const combined = new BoundingBox();
        let first = true;

        for (const instance of this.splats.values()) {
            if (first) {
                combined.copy(instance.bounds);
                first = false;
            } else {
                combined.add(instance.bounds);
            }
        }

        return combined;
    }
}
