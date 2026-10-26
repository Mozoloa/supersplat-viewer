import { mediaFetch } from './media-request';
import { readTexturedHeader } from './textured-splat';

export type Matrix4 = [
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
    number, number, number, number
];

export interface SceneManifest {
    format: 'ems-spatial-scene';
    version: 1;
    kind: 'static-splat' | 'animated-splat';
    coordinateSystem: {
        handedness: 'right';
        up: '+Y';
        forward: '-Z';
        units: 'meters';
        matrixLayout: 'row-major';
    };
    asset: {
        uri: string;
        type: 'gaussian-splat';
        encoding: 'ply' | 'supersplat-compressed-ply' | 'sog' | 'splatseq' | 'splatstream' | 'gstex';
    };
    contentToWorld: Matrix4;
    captureCamera: {
        cameraToWorld: Matrix4;
        intrinsics: {
            projection: 'perspective';
            fx: number;
            fy: number;
            cx: number;
            cy: number;
            width: number;
            height: number;
        };
        near?: number;
        far?: number;
    };
    grabPivot?: [number, number, number];
}

export interface LoadedSceneDefinition {
    manifest: SceneManifest;
    manifestUrl: string | null;
    assetUrl: string;
    authored: boolean;
    warning: string | null;
}

export const IDENTITY_MATRIX: Matrix4 = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
];

const isFiniteArray = (value: unknown, length: number): value is number[] => (
    Array.isArray(value)
    && value.length === length
    && value.every(item => typeof item === 'number' && Number.isFinite(item))
);

const validateManifest = (value: unknown): SceneManifest => {
    const scene = value as Partial<SceneManifest> | null;
    if (!scene || scene.format !== 'ems-spatial-scene' || scene.version !== 1) {
        throw new Error('Unsupported scene manifest. Expected ems-spatial-scene version 1.');
    }
    if (scene.kind !== 'static-splat' && scene.kind !== 'animated-splat') {
        throw new Error('Scene manifest has an unsupported kind.');
    }
    if (!scene.asset?.uri || scene.asset.type !== 'gaussian-splat') {
        throw new Error('Scene manifest is missing a Gaussian splat asset.');
    }
    if (!isFiniteArray(scene.contentToWorld, 16)) {
        throw new Error('Scene manifest contentToWorld must contain 16 finite numbers.');
    }
    if (!isFiniteArray(scene.captureCamera?.cameraToWorld, 16)) {
        throw new Error('Scene manifest cameraToWorld must contain 16 finite numbers.');
    }
    const intrinsics = scene.captureCamera?.intrinsics;
    if (!intrinsics || intrinsics.fx <= 0 || intrinsics.fy <= 0
        || intrinsics.width < 1 || intrinsics.height < 1) {
        throw new Error('Scene manifest camera intrinsics are invalid.');
    }
    const coordinates = scene.coordinateSystem;
    if (!coordinates || coordinates.handedness !== 'right' || coordinates.up !== '+Y'
        || coordinates.forward !== '-Z' || coordinates.units !== 'meters'
        || coordinates.matrixLayout !== 'row-major') {
        throw new Error('Scene manifest coordinate system is not supported by NextPlayer.');
    }
    return scene as SceneManifest;
};

const encodingForUrl = (contentUrl: string): SceneManifest['asset']['encoding'] => {
    const pathname = new URL(contentUrl, location.href).pathname.toLowerCase();
    if (pathname.endsWith('.gstex')) return 'gstex';
    if (pathname.endsWith('.sog')) return 'sog';
    if (pathname.endsWith('.splatstream')) return 'splatstream';
    if (pathname.endsWith('.splatseq')) return 'splatseq';
    return pathname.endsWith('.compressed.ply') ? 'supersplat-compressed-ply' : 'ply';
};

export const deriveManifestUrl = (contentUrl: string): string => {
    const url = new URL(contentUrl, location.href);
    url.pathname = url.pathname
        .replace(/\.compressed\.ply$/i, '.ems.json')
        .replace(/\.(ply|sog|splatstream|gstex)$/i, '.ems.json');
    return url.href;
};

const mergeAuthenticationQuery = (assetUrl: URL, manifestUrl: URL): URL => {
    if (!assetUrl.search && manifestUrl.search) {
        assetUrl.search = manifestUrl.search;
    }
    return assetUrl;
};

const fallbackManifest = (contentUrl: string): SceneManifest => {
    const height = Math.max(1, window.innerHeight);
    const width = Math.max(1, window.innerWidth);
    const focal = height / (2 * Math.tan(Math.PI / 6));
    return {
        format: 'ems-spatial-scene',
        version: 1,
        kind: /\.(splatseq|splatstream)(?:$|[?#])/i.test(contentUrl) ? 'animated-splat' : 'static-splat',
        coordinateSystem: {
            handedness: 'right',
            up: '+Y',
            forward: '-Z',
            units: 'meters',
            matrixLayout: 'row-major'
        },
        asset: {
            uri: contentUrl,
            type: 'gaussian-splat',
            encoding: encodingForUrl(contentUrl)
        },
        contentToWorld: [...IDENTITY_MATRIX],
        captureCamera: {
            cameraToWorld: [...IDENTITY_MATRIX],
            intrinsics: {
                projection: 'perspective',
                fx: focal,
                fy: focal,
                cx: width * 0.5,
                cy: height * 0.5,
                width,
                height
            },
            near: 0.01,
            far: 1000
        }
    };
};

const embeddedPlyManifest = async (contentUrl: string): Promise<SceneManifest> => {
    const response = await mediaFetch(contentUrl, {
        headers: { Range: 'bytes=0-1048575' }
    });
    if (response.status !== 206) {
        throw new Error(`Static asset did not provide a bounded PLY header range (HTTP ${response.status}).`);
    }
    const header = new TextDecoder().decode(await response.arrayBuffer());
    const end = header.indexOf('end_header\n');
    if (end < 0) throw new Error('Static asset has no bounded PLY header.');
    const prefix = 'comment EMS_spatial ';
    const line = header.slice(0, end).split(/\r?\n/).find(value => value.startsWith(prefix));
    if (!line) throw new Error('Static asset has no EMS camera metadata.');
    const metadata = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
    // Stored EMS result metadata uses camelCase; PLY exporters use snake_case.
    // Both describe the same capture camera and placement.
    const coordinates = metadata.coordinate_system ?? metadata.coordinateSystem;
    const focalLength = metadata.focal_length_px ?? metadata.focalLengthPx;
    const cameraToWorld = metadata.camera_to_world ?? metadata.cameraToWorld;
    const grabPivot = metadata.grab_pivot ?? metadata.grabPivot;
    if (metadata.format !== 'ems-spatial' || metadata.version !== 1
        || coordinates !== 'right-handed-y-up-negative-z-forward'
        || !Number.isFinite(metadata.width) || Number(metadata.width) < 1
        || !Number.isFinite(metadata.height) || Number(metadata.height) < 1
        || !Number.isFinite(focalLength) || Number(focalLength) <= 0) {
        throw new Error('Static asset EMS camera metadata is invalid.');
    }
    const width = Number(metadata.width);
    const height = Number(metadata.height);
    const focal = Number(focalLength);
    return {
        format: 'ems-spatial-scene',
        version: 1,
        kind: 'static-splat',
        coordinateSystem: {
            handedness: 'right', up: '+Y', forward: '-Z', units: 'meters', matrixLayout: 'row-major'
        },
        asset: { uri: contentUrl, type: 'gaussian-splat', encoding: encodingForUrl(contentUrl) },
        contentToWorld: [...IDENTITY_MATRIX],
        ...(isFiniteArray(grabPivot, 3)
            ? { grabPivot: grabPivot as [number, number, number] }
            : {}),
        captureCamera: {
            cameraToWorld: isFiniteArray(cameraToWorld, 16) ? cameraToWorld as Matrix4 : [...IDENTITY_MATRIX],
            intrinsics: {
                projection: 'perspective', fx: focal, fy: focal,
                cx: width * 0.5, cy: height * 0.5, width, height
            },
            near: 0.01,
            far: 1000
        }
    };
};

export const loadSceneDefinition = async (
    contentUrl: string,
    explicitManifestUrl: string | null
): Promise<LoadedSceneDefinition> => {
    const manifestUrl = explicitManifestUrl
        ? new URL(explicitManifestUrl, location.href).href
        : deriveManifestUrl(contentUrl);

    try {
        const response = await mediaFetch(manifestUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const manifest = validateManifest(await response.json());
        const resolvedAsset = mergeAuthenticationQuery(
            new URL(manifest.asset.uri, manifestUrl),
            new URL(manifestUrl)
        );
        return {
            manifest,
            manifestUrl,
            assetUrl: contentUrl || resolvedAsset.href,
            authored: true,
            warning: null
        };
    } catch (error) {
        if (explicitManifestUrl) throw error;
        if (/\.gstex(?:$|[?#])/i.test(contentUrl)) {
            const response = await mediaFetch(contentUrl, { headers: { Range: 'bytes=0-65535' } });
            if (response.status !== 206) throw new Error('GStex requires a bounded metadata range.');
            const { header } = readTexturedHeader(await response.arrayBuffer());
            return { manifest: validateManifest(header.scene), manifestUrl: null, assetUrl: contentUrl, authored: true, warning: null };
        }
        if (/\.ply(?:$|[?#])/i.test(contentUrl)) {
            try {
                return {
                    manifest: await embeddedPlyManifest(contentUrl),
                    manifestUrl: null,
                    assetUrl: contentUrl,
                    authored: true,
                    warning: 'Using camera metadata embedded by the EMS spatial worker.'
                };
            } catch {
                // Personal files created before EMS spatial metadata continue
                // to open with the clearly labelled camera fallback below.
            }
        }
        return {
            manifest: fallbackManifest(contentUrl),
            manifestUrl: null,
            assetUrl: contentUrl,
            authored: false,
            warning: `No EMS placement metadata was found (${String(error)}). Using identity placement and a 60° fallback camera; no bounds fitting was applied.`
        };
    }
};
