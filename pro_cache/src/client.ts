import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import { IndexedDBCache, type IndexedDBConfig } from './db';
import { CacheManager } from './cache';
import { WebSocketClient, type WebSocketConfig } from './socket';

export interface ProCacheConfig {
    ws: WebSocketConfig;
    db?: IndexedDBConfig;
    api?: {
        baseUrl?: string;
        axiosInstance?: AxiosInstance;
        defaultCacheTtl?: number;
    };
    debug?: boolean;
    autoRefetchOnInvalidation?: boolean;
    getTimestamp?: (response: AxiosResponse) => number;
}

export interface RouteDef {
    path: string;
    cache_ttl?: number | null;
    background_delay?: number;
}

export class ProCacheClient {
    public db: IndexedDBCache;
    public cache: CacheManager;
    public socket: WebSocketClient;
    public api: AxiosInstance;
    
    public pendingFetches = new Map<string, Promise<any>>();
    public config: ProCacheConfig;

    constructor(config: ProCacheConfig) {
        this.config = config;
        this.db = new IndexedDBCache(config.db);
        this.cache = new CacheManager(this.db);
        this.socket = new WebSocketClient(this.cache, this.db, config.ws);
        
        this.api = config.api?.axiosInstance || axios.create({
            baseURL: config.api?.baseUrl || '/api',
            headers: {
                'Content-Type': 'application/json',
            },
        });
    }

    public async connect() {
        // Initialize connections
        await this.socket.connect();
    }

    public async disconnect() {
        this.socket.disconnect();
    }
    
    /**
     * Send a message via WebSocket (routed through Leader if needed)
     */
    public send(data: any) {
        this.socket.send(data);
    }
    
    /**
     * Listen for custom WebSocket messages
     */
    public on(type: string, callback: (payload: any) => void) {
        return this.socket.on(type, callback);
    }
    
    /**
     * Remove custom WebSocket listener
     */
    public off(type: string, callback: (payload: any) => void) {
        this.socket.off(type, callback);
    }
    
    /**
     * Enable or Disable caching globally
     */
    public enableCache(enabled: boolean) {
        this.socket.setIsCacheEnabled(enabled);
    }
    
    /**
    * Cache-aware fetch function
    */
    public async fetch<T>(
        route: RouteDef | string, 
        params?: Record<string, string | number>, 
        query?: Record<string, string | number>,
        cacheKeyOverride?: string
    ): Promise<T> {
        // Normalize input
        const routeDef: RouteDef = typeof route === 'string' ? { path: route, cache_ttl: this.config.api?.defaultCacheTtl } : route;
        const routePattern = routeDef.path; // This is the "Bucket" key (e.g. "/user/{id}")
        
        // Build specific URL/Key
        const url = this.buildPath(routePattern, params, query);
        const specificKey = cacheKeyOverride || url; // This is the "Item" key (e.g. "/user/1?q=a")
        const ttl = routeDef.cache_ttl;
        
        // Register background delay if specified
        if (routeDef.background_delay) {
            this.socket.setRouteDelay(specificKey, routeDef.background_delay);
        }
        
        // Check if caching is enabled
        let cachingEnabled = this.socket.isCacheEnabled();

        // 0. Wait for Socket (if configured)
        if (this.config.ws?.startup?.waitForSocket && !cachingEnabled && this.socket.wsStatus() !== 'connected') {
             const timeout = this.config.ws.startup.socketWaitTimeout ?? 5000;
             if (this.config.debug) console.log(`[ProCache] Waiting for socket connection (max ${timeout}ms)...`);
             
             const connected = await this.socket.waitForConnection(timeout);
             
             if (connected) {
                 if (this.config.debug) console.log(`[ProCache] Socket connected, proceeding with fetch`);
                 // Re-check cache enabled status (it might have flipped to true on connect)
                 cachingEnabled = this.socket.isCacheEnabled(); 
             } else {
                 console.warn(`[ProCache] Socket wait timed out, proceeding with default cache state: ${cachingEnabled}`);
             }
        }

        // Wait for cache sync from other tabs
        if (cachingEnabled) {
            await this.cache.waitForSync();
        }

        // 1. Check Cache (Bucket + Specific Key)
        if (cachingEnabled && ttl && ttl > 0) {
            const cached = await this.cache.get<T>(routePattern, specificKey);
            if (cached) {
                if (this.config.debug) console.log(`[ProCache] CACHE HIT for "${specificKey}" in bucket "${routePattern}"`);
                return cached;
            } else {
                if (this.config.debug) console.log(`[ProCache] CACHE MISS for "${specificKey}" in bucket "${routePattern}"`);
            }
        }

        // 2. Check for pending fetch (deduplication)
        if (this.pendingFetches.has(specificKey)) {
            if (this.config.debug) console.log(`[ProCache] Waiting for existing request "${specificKey}"`);
            return this.pendingFetches.get(specificKey) as Promise<T>;
        }

        // 3. Fetch Network
        const fetchPromise = (async () => {
            try {
                if (this.config.debug) console.log(`[ProCache] Fetching: ${url}`);
                const response = await this.api.get(url);
                const data = response.data;

                // 4. Set Cache
                if (cachingEnabled) {
                    if (!this.config.getTimestamp) {
                        throw new Error('[ProCache] Caching is enabled but "getTimestamp" callback is missing in config. You must provide a way to extract the server timestamp from the response to ensure data consistency.');
                    }

                    // Extract timestamp from response using user callback
                    const serverTimestamp = this.config.getTimestamp(response);
                    
                    // Update the timestamp for invalidation logic (associated with the Pattern/Bucket)
                    // Note: Invalidation usually happens against the Route Pattern
                    await this.db.setTimestamp(routePattern, serverTimestamp);
                    
                    if (ttl && ttl > 0) {
                        // Store in Bucket: Pattern -> SpecificKey -> Data
                        await this.cache.set(routePattern, specificKey, data, ttl);
                        if (this.config.debug) console.log(`[ProCache] Cached "${specificKey}" in bucket "${routePattern}" with TTL ${ttl}s`);
                    }
                }

                return data;
            } catch (error) {
                throw error;
            } finally {
                this.pendingFetches.delete(specificKey);
            }
        })();

        this.pendingFetches.set(specificKey, fetchPromise);
        return fetchPromise;
    }

    public buildPath(path: string, params?: Record<string, string | number>, query?: Record<string, string | number>) {
        let finalPath = path;
        
        // 1. Replace params
        if (params) {
            for (const [key, value] of Object.entries(params)) {
                finalPath = finalPath.replace(`{${key}}`, String(value));
            }
        }
        
        // 2. Handle Query Params
        if (query && Object.keys(query).length > 0) {
            const searchParams = new URLSearchParams();
            for (const [key, value] of Object.entries(query)) {
                if (value !== undefined && value !== null) {
                    searchParams.append(key, String(value));
                }
            }
            const queryString = searchParams.toString();
            if (queryString) {
                finalPath += (finalPath.includes('?') ? '&' : '?') + queryString;
            }
        }
        
        return finalPath;
    }
}
