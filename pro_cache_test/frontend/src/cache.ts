import { createProCache } from 'pro_cache';

let currentToken = '';

export const setCacheToken = (token: string) => {
    currentToken = token;
};

const apiBase = `http://${window.location.hostname}:3001/api`;
const WS_URL = `ws://${window.location.hostname}:8080/ws`;

export const cache = createProCache({ 
    debug: true,
    enabled:true,
    autoRefetchOnInvalidation: false,
    cacheWritesOffline: true, // Enable offline writing
     db: {
        dbName: 'finance_pro_cache',
        dbVersion: 1
    }, 
    api: {
        baseUrl: apiBase,
        defaultCacheTtl: 600
    },
    getTimestamp: (response) => {
        const serverTs = response.headers?.['x-server-timestamp'];
        return serverTs ? parseInt(serverTs, 10) : Date.now();
    },
    ws: {
        url: () => `${WS_URL}?token=${currentToken}`,
        routeToCacheKey: (routePath: string) => routePath,
        activityIndicatorDuration: 1000,
        startup: {
            enableCacheBeforeSocket: false, // Don't serve stale data on boot
            waitForSocket: true,            // Wait for socket to connect
            socketWaitTimeout: 3000         // 3s timeout
        },
        defaultBackgroundDelay: 1000,
        backgroundPollInterval: 200,
        shouldInvalidate: async (key, value, db) => {
            if (cache.config.debug) console.log(`[App] Checking invalidation for ${key}`, value);
            if (key === 'all') {
                 if (cache.config.debug) console.log('[App] Full cache clear requested');
                 return true; 
            }
            const localTs = await db.getTimestamp(key);
            if (localTs && localTs >= value) {
                if (cache.config.debug) console.log(`[App] Ignoring stale data for ${key}`);
                return false;
            }
            return true;
        },
        handleMessage: async (msg, ctx, defaultHandler) => {
             ctx.log('[App] Custom Message Middleware:', msg);

             // Handle maintenance mode
             if (msg.type === 'server-maintenance') {
                 alert('Maintenance Mode: ' + msg.message);
                 return;
             }

             // 2. Manual Invalidation Handling (Sync/Delta)
             // User explicitly wants to demonstrate/override this logic here.
             if (msg.type === 'invalidate' || msg.type === 'invalidate-delta') {
                 const data = msg.data as Record<string, number>;
                 
                 // A) Full Sync Logic (type: 'invalidate')
                 if (msg.type === 'invalidate') {
                     const keys = Object.keys(data);
                     if (keys.length === 0) {
                         ctx.log('[App] Manual: Full Sync - Empty Data (Server Restart) -> Clearing ALL');
                         ctx.cache.clear();
                         await ctx.db.clearAll();
                         ctx.broadcast({ type: 'ws-invalidate-all', timestamp: Date.now() });
                         ctx.enableCache(); // Enable cache after sync
                         return;
                     }
                     
                     // Filter only "Fresh" keys (those we want to KEEP)
                     const validCacheKeys: string[] = [];
                     
                     for (const [key, timestamp] of Object.entries(data)) {
                         const localTs = await ctx.db.getTimestamp(key);
                         // If Local is Fresh (>= Server), we keep it.
                         if (localTs && localTs >= timestamp) {
                             validCacheKeys.push(ctx.routeToCacheKey(key));
                         } else {
                             // If Stale or Missing locally, we don't add it to validCacheKeys.
                             // invalidateExcept will wipe it out.
                             ctx.log(`[App] Manual: Stale data detected for ${key} - will be cleared by sync`);
                         }
                     }

                     ctx.log('[App] Manual: Full Sync - Keeping valid keys, clearing others (Stale + Missing)');
                     await ctx.invalidateExcept(validCacheKeys);
                     ctx.enableCache(); // Enable cache after sync
                     return;
                 }

                 // B) Handle Updates (Delta only)
                 for (const [key, timestamp] of Object.entries(data)) {
                     const localTs = await ctx.db.getTimestamp(key);
                     
                     if (localTs && localTs >= timestamp) {
                         ctx.log(`[App] Manual: Ignoring stale ${key}`);
                         continue;
                     }
                     
                     const cacheKey = ctx.routeToCacheKey(key);
                     ctx.log(`[App] Manual: Invalidating ${cacheKey} (from ${key})`);
                     ctx.cache.invalidate(cacheKey);
                     ctx.broadcast({ type: 'ws-invalidate', key: cacheKey, timestamp });
                     
                    if (document.hasFocus()) {
                         ctx.log(`[App] Manual: Active tab - triggering subscribers immediately`, cacheKey);
                         ctx.triggerSubscribers(cacheKey);
                     } else {
                         ctx.log(`[App] Manual: Background tab - polling subscribers`);
                         ctx.pollSubscribers(cacheKey);
                     }
                 }
                 return;
             }

             // 3. Default for everything else
             if (defaultHandler) {
                 await defaultHandler(msg);
             }
        }
    }
});
