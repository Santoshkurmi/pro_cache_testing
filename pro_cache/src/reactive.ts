import { createResource, onCleanup, type Accessor, type Resource, createEffect } from 'solid-js';
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
}

export function createLiveFetch<T>(
    client: ProCacheClient,
    source: Accessor<RouteSource> | RouteSource,
    params?: Accessor<Record<string, string | number> | undefined> | Record<string, string | number>,
    options?: Accessor<LiveFetchOptions | undefined> | LiveFetchOptions
): [Resource<T | undefined>, { refetch: (info?: unknown) => T | Promise<T | undefined> | undefined | null }] {
    // 1. Version signal to trigger refetch


    // 2. Create the resource
    // The source function combines the route, params, and version to trigger updates
    const [data, { refetch }] = createResource(
        () => {
            const s = typeof source === 'function' ? (source as Accessor<RouteSource>)() : source;
            const p = typeof params === 'function' ? (params as Accessor<Record<string, string | number> | undefined>)() : params;
            const o = typeof options === 'function' ? (options as Accessor<LiveFetchOptions | undefined>)() : options;
            // Return a tracking object that includes version
            return { source: s, params: p, options: o };
        },
        async ({ source, params, options }) => {
            // Unpack and fetch
            return client.fetch<T>(source, params, options?.cacheKey);
        }
    );

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
        const p = typeof params === 'function' ? (params as Accessor<Record<string, string | number> | undefined>)() : params;
        const o = typeof options === 'function' ? (options as Accessor<LiveFetchOptions | undefined>)() : options;
        
        if (!s) return;

        const path = typeof s === 'string' ? s : s.path;
        
        const url = client.buildPath(path, p);
        const key = o?.cacheKey || url;

        console.log(`[createLiveFetch] Subscribing to key: ${key}`);
        cleanupFn = client.socket.onInvalidate(key, () => {
             console.log(`[createLiveFetch] Invalidation received for key: ${key}, triggering refetch`);
             // Use refetch from createResource directly
             refetch();
        });
    };

    createEffect(() => {
        computeKeyAndSubscribe();
    });

    onCleanup(() => {
        if (cleanupFn) cleanupFn();
    });

    return [data, { refetch }];
}
