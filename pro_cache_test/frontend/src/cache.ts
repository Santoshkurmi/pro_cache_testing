import { createProCache } from 'pro_cache';

let currentToken = '';

export const setCacheToken = (token: string) => {
    currentToken = token;
};

const apiBase = `http://${window.location.hostname}:3001/api`;
const WS_URL = `ws://${window.location.hostname}:8080/ws`;

export const cache = createProCache({ 
    debug: true,
    autoRefetchOnInvalidation: false,
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
        startup: {
            enableCacheBeforeSocket: false, // Don't serve stale data on boot
            waitForSocket: true,            // Wait for socket to connect
            socketWaitTimeout: 3000         // 3s timeout
        },
        defaultBackgroundDelay: 1000,
        backgroundPollInterval: 200,
        shouldInvalidate: async (key, value, db) => {
            console.log(`[App] Checking invalidation for ${key}`, value);
            if (key === 'all') {
                 console.log('[App] Full cache clear requested');
                 return true; 
            }
            const localTs = await db.getTimestamp(key);
            if (localTs && localTs >= value) {
                console.log(`[App] Ignoring stale data for ${key}`);
                return false;
            }
            return true;
        },
        handleMessage: async (msg, ctx) => {
             console.log('[App] Custom Message Middleware:', msg);
             if (msg.type === 'server-maintenance') {
                 alert('Maintenance Mode: ' + msg.message);
                 return;
             }

             if (msg.type === 'invalidate' && msg.data) {
                 const data = msg.data;
                 const keys = Object.keys(data);
                 
                 if (keys.includes('all')) {
                     console.log('[App] Manual: Clearing ALL cache');
                     ctx.cache.clear();
                     await ctx.db.clearAll();
                     ctx.broadcast({ type: 'ws-invalidate-all', timestamp: data['all'] });
                     return;
                 }

                 for (const [key, timestamp] of Object.entries(data)) {
                     const localTs = await ctx.db.getTimestamp(key);
                     
                     if (localTs && localTs >= (timestamp as number)) {
                         console.log(`[App] Manual: Ignoring stale ${key}`);
                         continue;
                     }
                     
                     const cacheKey = ctx.routeToCacheKey(key);
                     console.log(`[App] Manual: Invalidating ${cacheKey} (from ${key})`);
                     ctx.cache.invalidate(cacheKey);
                     console.log(`[App] Manual: Broadcasting update to followers: ${cacheKey}`);
                     ctx.broadcast({ type: 'ws-invalidate', key: cacheKey, timestamp });
                     
                     if (document.hasFocus()) {
                         console.log(`[App] Manual: Active tab - triggering subscribers immediately`);
                         ctx.triggerSubscribers(cacheKey);
                     } else {
                         console.log(`[App] Manual: Background tab - polling subscribers`);
                         ctx.pollSubscribers(cacheKey);
                     }
                 }
                 return;
             }
             
             console.warn('[App] Unknown message type:', msg.type);
        }
    }
});
