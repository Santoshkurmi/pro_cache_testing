import { createResource, onCleanup, type Accessor, type Resource, createEffect, createSignal } from 'solid-js';
import { ProCacheClient, type RouteDef } from './client';

export type RouteSource = string | RouteDef;

/**
 * Creates a reactive resource that automatically refetches when the socket receives an invalidation.
 * 
 * @param client The ProCacheClient instance
 * @param source The route path or definition (can be a signal/accessor)
 * @param params Optional path parameters (can be a signal/accessor)
 */
export interface LiveFetchOptions {
    cacheKey?: string;
    autoRefetch?: boolean;
    params?: Record<string, string | number>;
    query?: Record<string, string | number>;
}

export interface LiveFetchResult<T> {
    data: Resource<T | undefined>;
    refetch: (info?: { force?: boolean }) => T | Promise<T | undefined> | undefined | null;
    isRefetching: Accessor<boolean>;
    isRefetchNeeded: Accessor<boolean>;
}

export function createLiveFetch<T>(
    client: ProCacheClient,
    source: Accessor<RouteSource> | RouteSource,
    options?: Accessor<LiveFetchOptions | undefined> | LiveFetchOptions
): [Resource<T | undefined>, { refetch: (info?: { force?: boolean }) => any; isRefetching: Accessor<boolean>; isRefetchNeeded: Accessor<boolean> }] {
    // 1. Internal Signals
    const [isRefetching, setIsRefetching] = createSignal(false);
    const [isRefetchNeeded, setIsRefetchNeeded] = createSignal(false);

    // 1. Reactive Input Normalization
    // We don't need dedicated signals, we can just derive execution arguments inside the fetcher

    // 2. Create the resource
    // The source function combines the route, params, and version to trigger updates
    const [data, { refetch: originalRefetch }] = createResource(
        () => {
            const s = typeof source === 'function' ? (source as Accessor<RouteSource>)() : source;
            const o = typeof options === 'function' ? (options as Accessor<LiveFetchOptions | undefined>)() : options;
            // Return a tracking object that includes version
            return { source: s, options: o };
        },
        async ({ source, options }) => {
            // Unpack and fetch
            try {
                // Workaround: We will use a signal/ref "nextRefetchForce" that we read here.
                const force = nextRefetchForce;
                nextRefetchForce = false; // consume it
                return await client.fetch<T>(source, options?.params, options?.query, options?.cacheKey, force);
            } finally {
               setIsRefetching(false);
            }
        }
    );

    // Side-channel for force param
    let nextRefetchForce = false;

    // Wrapped refetch to toggle isRefetching
    const refetch = (info?: { force?: boolean }) => {
        setIsRefetching(true);
        setIsRefetchNeeded(false); // Reset needed state
        if (info?.force) nextRefetchForce = true;
        return originalRefetch(info);
    };

    // 3. Setup Socket Subscription
    
    // Track the current subscription cleanup
    let cleanupFn: (() => void) | null = null;

    // Computed to track the current key and subscribe
    // This runs whenever source or params change
    const computeKeyAndSubscribe = () => {
        // Clean up previous subscription
        if (cleanupFn) {
            cleanupFn();
            cleanupFn = null;
        }

        const s = typeof source === 'function' ? (source as Accessor<RouteSource>)() : source;
        const o = typeof options === 'function' ? (options as Accessor<LiveFetchOptions | undefined>)() : options;
        
        if (!s) return;

        const path = typeof s === 'string' ? s : s.path;
        
        const url = client.buildPath(path, o?.params, o?.query);
        const key = o?.cacheKey || url;
        
        // Resolve autoRefetch: Option > Config > Default (false)
        const shouldAutoRefetch = o?.autoRefetch ?? client.config.autoRefetchOnInvalidation ?? false;

        console.log(`[createLiveFetch] Subscribing to key: ${key}`);
        
        const handleInvalidation = (auto: boolean) => {
             if (auto) {
                 console.log(`[createLiveFetch] Auto-refetching...`);
                 refetch();
             } else {
                 console.log(`[createLiveFetch] Marked as needed (autoRefetch disabled).`);
                 setIsRefetchNeeded(true);
             }
        };

        const unsub1 = client.socket.onInvalidate(key, () => {
             console.log(`[createLiveFetch] Invalidation received for key: ${key}`);
             handleInvalidation(shouldAutoRefetch);
        });

        // Dual Subscription: Watch Path Pattern as well if different
        let unsub2 = () => {};
        if (path !== key) {
            console.log(`[createLiveFetch] Subscribing to pattern: ${path}`);
            unsub2 = client.socket.onInvalidate(path, () => {
                console.log(`[createLiveFetch] Invalidation received for pattern: ${path}`);
                handleInvalidation(shouldAutoRefetch);
            });
        }

        cleanupFn = () => {
            unsub1();
            unsub2();
        };
    };

    createEffect(() => {
        computeKeyAndSubscribe();
    });

    onCleanup(() => {
        if (cleanupFn) cleanupFn();
    });

    return [data, { refetch, isRefetching, isRefetchNeeded }];
}

/**
 * SolidJS Primitive to subscribe to global invalidations ("all" events)
 */
export function createGlobalInvalidation(client: ProCacheClient, callback: () => void) {
    let cleanupFn: (() => void) | null = null;
    
    createEffect(() => {
        if (cleanupFn) cleanupFn();
        cleanupFn = client.socket.onGlobalInvalidate(callback);
    });

    onCleanup(() => {
        if (cleanupFn) cleanupFn();
    });
}
