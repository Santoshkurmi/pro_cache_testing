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
        cacheKeyOverride?: string
    ): Promise<T> {
        // Normalize input
        const routeDef: RouteDef = typeof route === 'string' ? { path: route, cache_ttl: this.config.api?.defaultCacheTtl } : route;
        
        // Build URL
        const url = this.buildPath(routeDef.path, params);
        const key = cacheKeyOverride || url;
        const ttl = routeDef.cache_ttl;
        
        // Register background delay if specified
        if (routeDef.background_delay) {
            this.socket.setRouteDelay(key, routeDef.background_delay);
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

        // 1. Check Cache
        if (cachingEnabled && ttl && ttl > 0) {
            const cached = await this.cache.get<T>(key);
            if (cached) {
                if (this.config.debug) console.log(`[ProCache] CACHE HIT for "${key}"`);
                return cached;
            } else {
                if (this.config.debug) console.log(`[ProCache] CACHE MISS for "${key}"`);
            }
        }

        // 2. Check for pending fetch (deduplication)
        if (this.pendingFetches.has(key)) {
            if (this.config.debug) console.log(`[ProCache] Waiting for existing request "${key}"`);
            return this.pendingFetches.get(key) as Promise<T>;
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
                    
                    // Update the timestamp for invalidation logic
                    await this.db.setTimestamp(key, serverTimestamp);
                    
                    if (ttl && ttl > 0) {
                        await this.cache.set(key, data, ttl);
                        if (this.config.debug) console.log(`[ProCache] Cached "${key}" with TTL ${ttl}s`);
                    }
                }

                return data;
            } catch (error) {
                throw error;
            } finally {
                this.pendingFetches.delete(key);
            }
        })();

        this.pendingFetches.set(key, fetchPromise);
        return fetchPromise;
    }

    public buildPath(path: string, params?: Record<string, string | number>) {
        let finalPath = path;
        if (params) {
            for (const [key, value] of Object.entries(params)) {
                finalPath = finalPath.replace(`{${key}}`, String(value));
            }
        }
        return finalPath;
    }
}
