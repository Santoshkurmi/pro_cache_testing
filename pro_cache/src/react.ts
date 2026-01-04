import { useState, useEffect, useCallback, useRef } from 'react';
import { ProCacheClient, type RouteDef } from './client';

export type RouteSource = string | RouteDef;

export interface LiveFetchOptions {
    cacheKey?: string;
}

export interface LiveFetchResult<T> {
    data: T | undefined;
    loading: boolean;
    error: any;
    refetch: () => Promise<void>;
}

/**
 * React Hook for ProCache live fetching
 */
export function useLiveFetch<T>(
    client: ProCacheClient,
    source: RouteSource,
    params?: Record<string, string | number>,
    options?: LiveFetchOptions
): LiveFetchResult<T> {
    const [data, setData] = useState<T | undefined>(undefined);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<any>(null);
    
    // Version Ref to handle race conditions
    const versionRef = useRef(0);

    const fetchData = useCallback(async (isRefetch = false) => {
        const currentVersion = versionRef.current;
        if (!isRefetch) setLoading(true);
        setError(null);

        try {
            const result = await client.fetch<T>(source, params, options?.cacheKey);
            if (versionRef.current === currentVersion) {
                setData(result);
            }
        } catch (err) {
            if (versionRef.current === currentVersion) {
                setError(err);
            }
        } finally {
            if (versionRef.current === currentVersion) {
                setLoading(false);
            }
        }
    }, [client, source, JSON.stringify(params), options?.cacheKey]);

    useEffect(() => {
        // Increment version to invalidate previous in-flight requests
        versionRef.current++;
        fetchData();

        // Subscription Logic
        const path = typeof source === 'string' ? source : source.path;
        const url = client.buildPath(path, params);
        const key = options?.cacheKey || url;

        console.log(`[useLiveFetch] Subscribing to key: ${key}`);
        const unsubscribe = client.socket.onInvalidate(key, () => {
             console.log(`[useLiveFetch] Invalidation received for key: ${key}, triggering refetch`);
             fetchData(true); // Refetch silently (keep current data while fetching)
        });

        return () => {
            console.log(`[useLiveFetch] Unsubscribing from key: ${key}`);
            unsubscribe();
        };
    }, [fetchData, client, source, JSON.stringify(params), options?.cacheKey]);

    return { data, loading, error, refetch: () => fetchData(true) };
}
