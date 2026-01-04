import { IndexedDBCache } from './db';

export interface CacheItem<T = any> {
    data: T;
    expiry: number;
}

type CacheMessage = 
    | { type: 'cache-set', key: string, data: any, expiry: number }
    | { type: 'cache-invalidate', pattern: string }
    | { type: 'cache-request', requestId: string }
    | { type: 'cache-response', requestId: string, cache: Array<[string, CacheItem]> };

export class CacheManager {
    private cache: Map<string, CacheItem> = new Map();
    private channel: BroadcastChannel | null = null;
    private isInitialized = false;
    private pendingRequests: Map<string, (cache: Array<[string, CacheItem]>) => void> = new Map();
    private db: IndexedDBCache;
    
    // Sync promise - fetchRoute waits for this
    private syncPromise: Promise<void> | null = null;
    private syncResolve: (() => void) | null = null;

    constructor(db: IndexedDBCache, channelName: string = 'pro-cache-sync') {
        this.db = db;
        // Initialize BroadcastChannel for cross-tab sync
        if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
            this.channel = new BroadcastChannel(channelName);
            this.channel.onmessage = (event: MessageEvent<CacheMessage>) => {
                this.handleMessage(event.data);
            };
            
            // Create sync promise immediately - fetchRoute will wait on this
            this.syncPromise = new Promise((resolve) => {
                this.syncResolve = resolve;
            });
            
            // Load from IndexedDB immediately (offline-first)
            this.loadFromIndexedDB();
        } else {
            // No BroadcastChannel, mark as immediately ready
            this.isInitialized = true;
        }
    }

    /**
     * Load cache from IndexedDB on init (offline-first)
     */
    private async loadFromIndexedDB() {
        // Note: We don't validate timestamps here - that happens in socket.ts when connection is established
        // This provides instant cache hit on page load
        console.debug('[Cache] Loading from IndexedDB...');
        
        // For now, we just mark as initialized
        // The actual cache items will be loaded on-demand from IndexedDB via get()
        this.isInitialized = true;
        this.syncResolve?.();
    }

    /**
     * Wait for sync to complete (called by fetchRoute)
     */
    async waitForSync(): Promise<void> {
        if (this.isInitialized || !this.syncPromise) return;
        await this.syncPromise;
    }

    /**
     * Request cache from other tabs (for new tabs)
     */
    async requestCacheFromOtherTabs(): Promise<void> {
        if (!this.channel || this.isInitialized) {
            // Already initialized, resolve sync promise
            this.syncResolve?.();
            return;
        }

        return new Promise((resolve) => {
            const requestId = Math.random().toString(36).substring(7);

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                this.isInitialized = true;
                console.debug('[Cache] No response from other tabs, starting fresh');
                this.syncResolve?.(); // Resolve sync promise
                resolve();
            }, 200); // 200ms timeout for faster first-tab boot

            // Register promise resolver
            this.pendingRequests.set(requestId, (cacheData) => {
                clearTimeout(timeout);
                this.pendingRequests.delete(requestId);
                
                //syncResolve Import cache from other tab
                cacheData.forEach(([key, item]) => {
                    this.cache.set(key, item);
                });
                
                this.isInitialized = true;
                console.debug(`[Cache] Received ${cacheData.length} items from other tab`);
                this.syncResolve?.(); // Resolve sync promise
                resolve();
            });

            // Request cache
            this.channel!.postMessage({ type: 'cache-request', requestId } as CacheMessage);
        });
    }

    private handleMessage(msg: CacheMessage) {
        if (msg.type === 'cache-set') {
            // Set cache from other tab (don't broadcast again)
            this.cache.set(msg.key, { data: msg.data, expiry: msg.expiry });
            console.debug(`[Cache] Synced from other tab: ${msg.key}`);
        } else if (msg.type === 'cache-invalidate') {
            // Invalidate from other tab (don't broadcast again)
            this.invalidateLocal(msg.pattern);
            console.debug(`[Cache] Invalidated from other tab: ${msg.pattern}`);
        } else if (msg.type === 'cache-request') {
            // Another tab wants our cache
            if (this.isInitialized && this.cache.size > 0) {
                const cacheArray = Array.from(this.cache.entries());
                this.channel?.postMessage({ 
                    type: 'cache-response', 
                    requestId: msg.requestId, 
                    cache: cacheArray 
                } as CacheMessage);
                console.debug(`[Cache] Sent ${cacheArray.length} items to new tab`);
            }
        } else if (msg.type === 'cache-response') {
            // Response to our request
            const resolver = this.pendingRequests.get(msg.requestId);
            if (resolver) {
                resolver(msg.cache);
            }
        }
    }

    /**
     * Set data in cache with a TTL (in seconds)
     * Optionally save to IndexedDB for persistence
     */
    async set(key: string, data: any, ttlSeconds: number, persistToIndexedDB = true) {
        if (!ttlSeconds || ttlSeconds <= 0) return;
        
        // Don't cache null, undefined, or empty data
        if (data === null || data === undefined) {
            console.debug(`[Cache] Skipping cache for ${key} - data is null/undefined`);
            return;
        }
        
        // For arrays, don't cache if empty
        // if (Array.isArray(data) && data.length === 0) {
        //     console.debug(`[Cache] Skipping cache for ${key} - empty array`);
        //     return;
        // }
        
        const expiry = Date.now() + (ttlSeconds * 1000);
        this.cache.set(key, { data, expiry });
        this.isInitialized = true;
        console.debug(`[Cache] Set ${key} (TTL: ${ttlSeconds}s)`);

        // Persist to IndexedDB
        if (persistToIndexedDB) {
            await this.db.setCache(key, { data, expiry });
        }

        // Broadcast to other tabs
        this.channel?.postMessage({ 
            type: 'cache-set', 
            key, 
            data, 
            expiry 
        } as CacheMessage);
    }

    /**
     * Get data from cache if it exists and hasn't expired
     * Falls back to IndexedDB if not in memory
     */
    async get<T>(key: string): Promise<T | null> {
        // Check memory cache first
        let item = this.cache.get(key);
        
        // If not in memory, try IndexedDB
        if (!item) {
            const dbItem = await this.db.getCache(key);
            if (dbItem) {
                item = { data: dbItem.data, expiry: dbItem.expiry };
                // Restore to memory cache
                this.cache.set(key, item);
                console.debug(`[Cache] Restored from IndexedDB: ${key}`);
            }
        }
        
        if (!item) return null;

        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            await this.db.deleteCache(key);
            console.debug(`[Cache] Expired ${key}`);
            return null;
        }
        
        // Validate that data exists and is not null/undefined
        if (item.data === null || item.data === undefined) {
            console.debug(`[Cache] Invalid data for ${key} - returning null`);
            this.cache.delete(key);
            await this.db.deleteCache(key);
            return null;
        }

        console.debug(`[Cache] Hit ${key}`);
        return item.data as T;
    }

    /**
     * Invalidate cache keys locally without broadcasting
     */
    private invalidateLocal(startWithPattern: string) {
        let count = 0;
        for (const key of this.cache.keys()) {
            if (key.startsWith(startWithPattern) || key === startWithPattern) {
                this.cache.delete(key);
                // Also delete from IndexedDB
                this.db.deleteCache(key);
                count++;
            }
        }
        if (count > 0) {
            console.debug(`[Cache] Invalidated ${count} items matching "${startWithPattern}"`);
        }
    }

    /**
     * Invalidate cache keys matching a pattern.
     */
    invalidate(startWithPattern: string) {
        this.invalidateLocal(startWithPattern);
        
        // Broadcast to other tabs
        this.channel?.postMessage({ 
            type: 'cache-invalidate', 
            pattern: startWithPattern 
        } as CacheMessage);
    }

    async clear() {
        this.cache.clear();
        await this.db.clearCache();
    }
}
