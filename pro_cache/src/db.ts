/**
 * IndexedDB wrapper for persistent caching
 * Stores route timestamps and cached data
 */

export interface CachedData {
    data: any;
    expiry: number;
    timestamp?: number; // Route timestamp when this was cached
}

export interface IndexedDBConfig {
    dbName: string;
    dbVersion?: number;
    timestampStoreName?: string;
    cacheStoreName?: string;
}

export class IndexedDBCache {
    private db: IDBDatabase | null = null;
    private initPromise: Promise<void> | null = null;
    private config: IndexedDBConfig;

    constructor(config?: Partial<IndexedDBConfig>) {
        this.config = {
            dbName: config?.dbName || 'pro-cache-db',
            dbVersion: config?.dbVersion || 1,
            timestampStoreName: config?.timestampStoreName || 'timestamps',
            cacheStoreName: config?.cacheStoreName || 'cache'
        };

        if (typeof window !== 'undefined' && 'indexedDB' in window) {
            this.initPromise = this.init();
        }
    }

    private async init(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.config.dbName, this.config.dbVersion);

            request.onerror = () => {
                console.error('[IndexedDB] Failed to open database', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;

                // Timestamps store: route path -> timestamp
                if (!db.objectStoreNames.contains(this.config.timestampStoreName!)) {
                    db.createObjectStore(this.config.timestampStoreName!);
                }

                // Cache store: cache key -> {data, expiry, timestamp}
                if (!db.objectStoreNames.contains(this.config.cacheStoreName!)) {
                    db.createObjectStore(this.config.cacheStoreName!);
                }
            };
        });
    }

    private async ensureDB(): Promise<IDBDatabase> {
        if (this.initPromise) {
            await this.initPromise;
        }
        if (!this.db) {
            throw new Error('IndexedDB not available');
        }
        return this.db;
    }

    // ========== Timestamp Operations ==========

    async setTimestamp(route: string, timestamp: number): Promise<void> {
        try {
            const db = await this.ensureDB();
            const tx = db.transaction(this.config.timestampStoreName!, 'readwrite');
            const store = tx.objectStore(this.config.timestampStoreName!);
            store.put(timestamp, route);
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn('[IndexedDB] Failed to set timestamp', e);
        }
    }

    async getTimestamp(route: string): Promise<number | null> {
        try {
            const db = await this.ensureDB();
            const tx = db.transaction(this.config.timestampStoreName!, 'readonly');
            const store = tx.objectStore(this.config.timestampStoreName!);
            const request = store.get(route);
            
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result ?? null);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.warn('[IndexedDB] Failed to get timestamp', e);
            return null;
        }
    }

    async getAllTimestamps(): Promise<Record<string, number>> {
        try {
            const db = await this.ensureDB();
            const tx = db.transaction(this.config.timestampStoreName!, 'readonly');
            const store = tx.objectStore(this.config.timestampStoreName!);
            const request = store.getAll();
            const keysRequest = store.getAllKeys();

            const [values, keys] = await Promise.all([
                new Promise<any[]>((resolve, reject) => {
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                }),
                new Promise<IDBValidKey[]>((resolve, reject) => {
                    keysRequest.onsuccess = () => resolve(keysRequest.result);
                    keysRequest.onerror = () => reject(keysRequest.error);
                })
            ]);

            const result: Record<string, number> = {};
            keys.forEach((key, index) => {
                result[key as string] = values[index];
            });
            return result;
        } catch (e) {
            console.warn('[IndexedDB] Failed to get all timestamps', e);
            return {};
        }
    }

    async setTimestamps(timestamps: Record<string, number>): Promise<void> {
        try {
            const db = await this.ensureDB();
            const tx = db.transaction(this.config.timestampStoreName!, 'readwrite');
            const store = tx.objectStore(this.config.timestampStoreName!);
            
            for (const [route, timestamp] of Object.entries(timestamps)) {
                if (route !== '_server_start') { // Don't store server_start as a route
                    store.put(timestamp, route);
                }
            }
            
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn('[IndexedDB] Failed to set timestamps', e);
        }
    }

    // ========== Cache Operations ==========

    async setCache(key: string, data: CachedData): Promise<void> {
        try {
            const db = await this.ensureDB();
            const tx = db.transaction(this.config.cacheStoreName!, 'readwrite');
            const store = tx.objectStore(this.config.cacheStoreName!);
            store.put(data, key);
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn('[IndexedDB] Failed to set cache', e);
        }
    }

    async getCache(key: string): Promise<CachedData | null> {
        try {
            const db = await this.ensureDB();
            const tx = db.transaction(this.config.cacheStoreName!, 'readonly');
            const store = tx.objectStore(this.config.cacheStoreName!);
            const request = store.get(key);
            
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result ?? null);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.warn('[IndexedDB] Failed to get cache', e);
            return null;
        }
    }

    async deleteCache(key: string): Promise<void> {
        try {
            const db = await this.ensureDB();
            const tx = db.transaction(this.config.cacheStoreName!, 'readwrite');
            const store = tx.objectStore(this.config.cacheStoreName!);
            store.delete(key);
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn('[IndexedDB] Failed to delete cache', e);
        }
    }

    async clearCache(): Promise<void> {
        try {
            const db = await this.ensureDB();
            const tx = db.transaction(this.config.cacheStoreName!, 'readwrite');
            const store = tx.objectStore(this.config.cacheStoreName!);
            store.clear();
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            console.debug('[IndexedDB] Cleared all cache');
        } catch (e) {
            console.warn('[IndexedDB] Failed to clear cache', e);
        }
    }

    async clearTimestamps(): Promise<void> {
        try {
            const db = await this.ensureDB();
            const tx = db.transaction(this.config.timestampStoreName!, 'readwrite');
            const store = tx.objectStore(this.config.timestampStoreName!);
            store.clear();
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            console.debug('[IndexedDB] Cleared all timestamps');
        } catch (e) {
            console.warn('[IndexedDB] Failed to clear timestamps', e);
        }
    }

    async clearAll(): Promise<void> {
        await Promise.all([
            this.clearCache(),
            this.clearTimestamps()
        ]);
    }
}
