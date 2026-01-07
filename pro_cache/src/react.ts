import React, { useState, useEffect, useCallback, useRef, useContext, createContext } from 'react';
import { createRoot, createEffect } from 'solid-js';
import { ProCacheClient, type RouteDef } from './client';
import { type ConnectionStatus } from './socket';

export type RouteSource = string | RouteDef;

export interface LiveFetchOptions {
    cacheKey?: string;
    autoRefetch?: boolean;
    params?: Record<string, string | number>;
    query?: Record<string, string | number>;
}

export interface LiveFetchResult<T> {
    data: T | undefined;
    loading: boolean;
    error: any;
    refetch: () => Promise<void>;
    isRefetching: boolean;      // True when a background update is in progress
    isRefetchNeeded: boolean;   // True when invalidated but not auto-fetched
}

export interface ProCacheStatus {
    wsStatus: ConnectionStatus;
    recentActivity: boolean;
    isLeaderTab: boolean;
    isOnline: boolean;
}

// Context for ProCache Client
const ProCacheContext = createContext<ProCacheClient | null>(null);

export const ProCacheProvider: React.FC<{ client: ProCacheClient; children: React.ReactNode }> = ({ client, children }) => {
    return React.createElement(ProCacheContext.Provider, { value: client }, children);
};

export const useProCache = () => {
    const client = useContext(ProCacheContext);
    if (!client) {
        throw new Error('useProCache must be used within a ProCacheProvider');
    }
    return client;
};

/**
 * React Hook to access ProCache socket status and metadata
 */
export function useProCacheStatus(): ProCacheStatus {
    const client = useProCache();
    const [status, setStatus] = useState<ProCacheStatus>({
        wsStatus: 'disconnected',
        recentActivity: false,
        isLeaderTab: false,
        isOnline: true
    });

    useEffect(() => {
        // Bridge SolidJS signals to React state using createRoot/createEffect
        let dispose: () => void;

        createRoot((cleanup) => {
            dispose = cleanup;
            
            createEffect(() => {
                const wsStatus = client.socket.wsStatus();
                const recentActivity = client.socket.recentActivity();
                const isLeaderTab = client.socket.isLeaderTab();
                const isOnline = client.socket.isOnline();

                setStatus({
                    wsStatus,
                    recentActivity,
                    isLeaderTab,
                    isOnline
                });
            });
        });

        return () => {
            if (dispose) dispose();
        };
    }, [client]);

    return status;
}

/**
 * React Hook to subscribe to global invalidations ("all" events)
 */
export function useGlobalInvalidation(callback: () => void) {
    const client = useProCache();
    
    useEffect(() => {
        const unsubscribe = client.socket.onGlobalInvalidate(callback);
        return () => {
            unsubscribe();
        };
    }, [client, callback]);
}

/**
 * React Hook for live invalidated fetching.
 * 
 * @param source Route path or definition
 * @param options Options including params, query, cacheKey, etc.
 */
export function useLiveFetch<T>(
    source: RouteSource,
    options?: LiveFetchOptions
): LiveFetchResult<T> {
    const client = useProCache(); // Use client from context
    const [data, setData] = useState<T | undefined>();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<any>(null);
    const [_, setVersion] = useState(0); // Used to trigger refetches manually or via invalidation
    const [isRefetching, setIsRefetching] = useState(false);
    const [isRefetchNeeded, setIsRefetchNeeded] = useState(false);
    const versionRef = useRef(0);

    // Resolve autoRefetch: Option > Config > Default (false)
    const shouldAutoRefetch = options?.autoRefetch ?? client.config.autoRefetchOnInvalidation ?? false;

    const fetchData = useCallback(async (isRefetch = false) => {
        const currentVersion = versionRef.current;
        if (!isRefetch) {
            setLoading(true);
        } else {
            setIsRefetching(true);
        }
        setError(null);

        try {
            const result = await client.fetch<T>(
                source, 
                options?.params, 
                options?.query, 
                options?.cacheKey
            );
            
            if (versionRef.current === currentVersion) {
                setData(result);
                setIsRefetchNeeded(false); // Reset needed state on successful fetch
                setVersion(prev => prev + 1); // Use version to trigger re-renders if needed, though setData usually enough
            }
        } catch (err) {
            if (versionRef.current === currentVersion) {
                setError(err);
            }
        } finally {
            if (versionRef.current === currentVersion) {
                if (!isRefetch) setLoading(false);
                else setIsRefetching(false);
            }
        }
    }, [client, source, JSON.stringify(options?.params), JSON.stringify(options?.query), options?.cacheKey]);

    useEffect(() => {
        // Increment version to invalidate previous in-flight requests
        versionRef.current++;
        fetchData();

        // Subscription Logic
        const path = typeof source === 'string' ? source : source.path;
        // Logic: We subscribe to the SPECIFIC KEY for this instance data refetching.
        const url = client.buildPath(path, options?.params, options?.query);
        const key = options?.cacheKey || url;

        console.log(`[useLiveFetch] Subscribing to key: ${key}`);
        const unsubscribe = client.socket.onInvalidate(key, () => {
             console.log(`[useLiveFetch] Invalidation received for key: ${key}`);
             
             if (shouldAutoRefetch) {
                 console.log(`[useLiveFetch] Auto-refetching...`);
                 fetchData(true); // Refetch silently
             } else {
                 console.log(`[useLiveFetch] Marked as needed (autoRefetch disabled).`);
                 setIsRefetchNeeded(true);
             }
        });

        return () => {
            console.log(`[useLiveFetch] Unsubscribing from key: ${key}`);
            unsubscribe();
        };
    }, [fetchData, client, source, JSON.stringify(options?.params), JSON.stringify(options?.query), options?.cacheKey, shouldAutoRefetch]);

    return { 
        data, 
        loading, 
        error, 
        refetch: () => fetchData(true),
        isRefetching,
        isRefetchNeeded
    };
}
