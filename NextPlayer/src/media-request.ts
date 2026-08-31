/**
 * Fetch private media with the viewer's session when the asset is served by
 * the same application origin. Cross-origin signed/public assets continue to
 * work without forwarding credentials to another origin.
 */
export const mediaFetch = (
    input: RequestInfo | URL,
    init: RequestInit = {}
): Promise<Response> => fetch(input, {
    ...init,
    credentials: 'same-origin'
});

export const isSameOriginMedia = (url: string | URL): boolean => (
    new URL(url, location.href).origin === location.origin
);
