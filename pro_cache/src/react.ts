import React, { useState, useEffect, useCallback, useRef, useContext, createContext } from 'react';
import { createRoot, createEffect } from 'solid-js';
import { ProCacheClient, type RouteDef } from './client';
import { type ConnectionStatus } from './socket';

export type RouteSource = string | RouteDef;

export interface LiveFetchOptions {
    cacheKey?: string;
    autoRefetch?: boolean;
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
 * React Hook for ProCache live fetching
 */
export function useLiveFetch<T>(
    source: RouteSource,
    params?: Record<string, string | number>,
    options?: LiveFetchOptions
): LiveFetchResult<T> {
    const client = useProCache(); // Use client from context
    
    // Resolve autoRefetch: Option > Config > Default (false)
    const shouldAutoRefetch = options?.autoRefetch ?? client.config.autoRefetchOnInvalidation ?? false;

    const [data, setData] = useState<T | undefined>(undefined);
    const [loading, setLoading] = useState<boolean>(true);
    const [isRefetching, setIsRefetching] = useState<boolean>(false);
    const [isRefetchNeeded, setIsRefetchNeeded] = useState<boolean>(false);
    const [error, setError] = useState<any>(null);
    
    // Version Ref to handle race conditions
    const versionRef = useRef(0);

    const fetchData = useCallback(async (isRefetch = false) => {
        const currentVersion = versionRef.current;
        if (!isRefetch) {
            setLoading(true);
        } else {
            setIsRefetching(true);
        }
        setError(null);

        try {
            const result = await client.fetch<T>(source, params, options?.cacheKey);
            if (versionRef.current === currentVersion) {
                setData(result);
                setIsRefetchNeeded(false); // Reset needed state on successful fetch
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
    }, [fetchData, client, source, JSON.stringify(params), options?.cacheKey, shouldAutoRefetch]);

    return { 
        data, 
        loading, 
        error, 
        refetch: () => fetchData(true),
        isRefetching,
        isRefetchNeeded
    };
}
