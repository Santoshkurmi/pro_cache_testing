import { IndexedDBCache } from './db';

export interface CacheItem<T = any> {
    data: T;
    expiry: number;
    timestamp: number; // Server-side timestamp
}

// Updated Message types for Bucket Strategy
type CacheMessage = 
    | { type: 'cache-set', bucket: string, key: string, data: any, expiry: number, timestamp: number }
    | { type: 'cache-invalidate', bucket: string } // Invalidate entire bucket
    | { type: 'cache-request', requestId: string }
    | { type: 'cache-response', requestId: string, cache: Array<[string, Record<string, CacheItem>]> }; // [Bucket, MapObject]

export class CacheManager {
    // Nested Map: Bucket -> (SpecificKey -> Item)
    private cache: Map<string, Map<string, CacheItem>> = new Map();
    private channel: BroadcastChannel | null = null;
    private isInitialized = false;
    private pendingRequests: Map<string, (cache: Array<[string, Record<string, CacheItem>]>) => void> = new Map();
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
        console.debug('[Cache] Loading from IndexedDB...');
        // We rely on lazy loading from DB on get() mostly, but we could preload keys if needed.
        // For now, just mark initialized.
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
            this.syncResolve?.();
            return;
        }

        return new Promise((resolve) => {
            const requestId = Math.random().toString(36).substring(7);

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                this.isInitialized = true;
                console.debug('[Cache] No response from other tabs, starting fresh');
                this.syncResolve?.();
                resolve();
            }, 200);

            // Register promise resolver
            this.pendingRequests.set(requestId, (cacheDump) => {
                clearTimeout(timeout);
                this.pendingRequests.delete(requestId);
                
                // Import cache from other tab
                cacheDump.forEach(([bucket, itemsMap]) => {
                    const currentBucket = this.getBucketMap(bucket);
                    Object.entries(itemsMap).forEach(([key, item]) => {
                        currentBucket.set(key, item);
                    });
                });
                
                this.isInitialized = true;
                console.debug(`[Cache] Received ${cacheDump.length} buckets from other tab`);
                this.syncResolve?.();
                resolve();
            });

            // Request cache
            this.channel!.postMessage({ type: 'cache-request', requestId } as CacheMessage);
        });
    }

    private handleMessage(msg: CacheMessage) {
        if (msg.type === 'cache-set') {
            // Set cache from other tab
            this.setLocal(msg.bucket, msg.key, { data: msg.data, expiry: msg.expiry, timestamp: msg.timestamp });
            console.debug(`[Cache] Synced from other tab: ${msg.key} in ${msg.bucket}`);
        } else if (msg.type === 'cache-invalidate') {
            // Invalidate bucket from other tab
            this.invalidateLocal(msg.bucket);
            console.debug(`[Cache] Invalidated bucket from other tab: ${msg.bucket}`);
        } else if (msg.type === 'cache-request') {
            // Another tab wants our cache
            if (this.isInitialized && this.cache.size > 0) {
                // Serialize Map<string, Map> to Array<[string, Object]>
                const dump: Array<[string, Record<string, CacheItem>]> = [];
                for (const [bucket, map] of this.cache.entries()) {
                    dump.push([bucket, Object.fromEntries(map)]);
                }

                this.channel?.postMessage({ 
                    type: 'cache-response', 
                    requestId: msg.requestId, 
                    cache: dump 
                } as CacheMessage);
            }
        } else if (msg.type === 'cache-response') {
            // Response to our request
            const resolver = this.pendingRequests.get(msg.requestId);
            if (resolver) {
                resolver(msg.cache);
            }
        }
    }

    private getBucketMap(bucket: string): Map<string, CacheItem> {
        if (!this.cache.has(bucket)) {
            this.cache.set(bucket, new Map());
        }
        return this.cache.get(bucket)!;
    }

    private setLocal(bucket: string, key: string, item: CacheItem) {
        const bucketMap = this.getBucketMap(bucket);
        const existing = bucketMap.get(key);
        
        if (!existing || item.timestamp >= existing.timestamp) {
            bucketMap.set(key, item);
        } else {
            console.debug(`[Cache] Skipping memory update for ${key} in ${bucket}: incoming ${item.timestamp} < existing ${existing.timestamp}`);
        }
    }

    /**
     * Set data in cache with a TTL (in seconds)
     */
    async set(bucketPattern: string, specificKey: string, data: any, ttlSeconds: number, timestamp: number, persistToIndexedDB = true) {
        if (!ttlSeconds || ttlSeconds <= 0) return;
        if (data === null || data === undefined) return;
        
        const expiry = Date.now() + (ttlSeconds * 1000);
        
        // Update Memory
        this.setLocal(bucketPattern, specificKey, { data, expiry, timestamp });
        this.isInitialized = true;

        // Persist to IndexedDB
        if (persistToIndexedDB) {
            await this.db.setCache(bucketPattern, specificKey, { data, expiry, timestamp });
        }

        // Broadcast to other tabs
        this.channel?.postMessage({ 
            type: 'cache-set', 
            bucket: bucketPattern,
            key: specificKey, 
            data, 
            expiry,
            timestamp
        } as CacheMessage);
    }

    /**
     * Get data from cache > memory > DB
     */
    async get<T>(bucketPattern: string, specificKey: string): Promise<T | null> {
        const bucketMap = this.getBucketMap(bucketPattern);
        let item = bucketMap.get(specificKey);
        
        // If not in memory, try IndexedDB
        if (!item) {
            const dbItem = await this.db.getCache(bucketPattern, specificKey);
            if (dbItem) {
                item = dbItem; // Use the full db item including timestamp
                // Restore to memory
                bucketMap.set(specificKey, item);
                console.debug(`[Cache] Restored from IndexedDB: ${specificKey}`);
            }
        }
        
        if (!item) return null;

        if (Date.now() > item.expiry) {
            bucketMap.delete(specificKey);
            return null;
        }
        
        return item.data as T;
    }

    /**
     * Find a key across all buckets (slow, used for polling/unknown bucket)
     */
    async find<T>(specificKey: string): Promise<T | null> {
        // 1. Search Memory
        for (const [bucket, map] of this.cache.entries()) {
            if (map.has(specificKey)) {
                return this.get<T>(bucket, specificKey);
            }
        }

        // 2. Search DB (We need a way to find which bucket a key is in, or search all buckets)
        // Since DB is Bucket -> Map, we can iterate buckets (keys of root store)
        // This is expensive but pollForCache is rare/background.
        const buckets = await this.db.getAllBucketKeys();
        for (const bucket of buckets) {
             const item = await this.get<T>(bucket, specificKey);
             if (item) return item;
        }
        
        return null;
    }

    /**
     * Get all currently cached keys for a bucket (Memory only is fine for notification triggering?)
     * Ideally we should know about DB keys too, but for invalidation, 
     * if it's not in memory, no React component is observing it (usually).
     */
    getKeys(bucketPattern: string): string[] {
        const map = this.cache.get(bucketPattern);
        return map ? Array.from(map.keys()) : [];
    }

    /**
     * Invalidate cache bucket locally
     */
    private invalidateLocal(bucketPattern: string) {
        if (this.cache.has(bucketPattern)) {
            this.cache.delete(bucketPattern);
            this.db.deleteCache(bucketPattern);
        }
        // Also check if any key matches exactly? No, bucket strategy relies on using the pattern as the bucket name.
    }

    /**
     * Invalidate cache bucket matching a pattern
     */
    invalidate(bucketPattern: string) {
        this.invalidateLocal(bucketPattern);
        
        // Broadcast
        this.channel?.postMessage({ 
            type: 'cache-invalidate', 
            bucket: bucketPattern 
        } as CacheMessage);
    }

    async clear() {
        this.cache.clear();
        await this.db.clearCache();
    }
}
