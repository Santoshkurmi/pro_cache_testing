# ProCache

High-performance reactive caching and WebSocket synchronization library for React & SolidJS.

ProCache provides a robust, multi-tab synchronization layer for your web applications. It implements a **Leader/Follower election system** to ensure only one WebSocket connection is active across multiple browser tabs, reducing server load and ensuring consistent data invalidation.

---

## 🏗 How It Works (Architecture)

ProCache is built to solve the "One Socket, Many Tabs" problem while keeping all tabs in perfect sync.

### 👑 Leader/Follower System
1.  **Election**: When you open your app, tabs coordinate using `localStorage` and `BroadcastChannel`. One tab becomes the **Leader**.
2.  **Single Connection**: Only the Leader opens a WebSocket connection to your backend.
3.  **Broadcast**: When the Leader receives an invalidation event from the server, it broadcasts that event to all **Follower** tabs via a `BroadcastChannel`.
4.  **Automatic Handoff**: If the Leader tab is closed, a Follower instantly detects the absence and elects itself as the new Leader, establishing a fresh WebSocket.

### 🔄 Multi-Tab Synchronization
-   **State Sync**: If you toggle the cache "OFF" in Tab #5, Tab #1 (Leader) will disconnect its socket, and every other tab will instantly update its UI to reflect the new state.
-   **Timestamp Guard**: Every piece of data is stored with a server-authoritative timestamp. If Tab A fetches data, Tab B will know it's fresh because they share the same IndexedDB and state logic.

---

## 🚀 Installation

```bash
npm install pro_cache
```

---

## ⚙️ Advanced Configuration

The `createProCache` function allows full control over how your app handles data and messages.

```typescript
import { createProCache } from 'pro_cache';

let currentToken = '';

export const setCacheToken = (token: string) => {
    currentToken = token;
};

const apiBase = `http://${window.location.hostname}:3001/api`;
const WS_URL = `ws://${window.location.hostname}:8080/ws`;

export const cache = createProCache({ 
    debug: true,
    enabled:localStorage.getItem('pro_cache_enabled') != 'false',
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
             if (msg.type === 'invalidate' || msg.type === 'invalidate-delta') {
                 const data = msg.data as Record<string, number>;
                 
                 // A) Full Sync Logic (type: 'invalidate')
                 if (msg.type === 'invalidate') {
                     // Check for Clock Drift / Server State Reset
                     const driftTime = msg.drift_time;
                     const storedDrift = localStorage.getItem('pro_cache_drift_time');

                     if (driftTime && String(driftTime) !== storedDrift) {
                         ctx.log(`[App] Manual: Clock Drift detected (${storedDrift} -> ${driftTime}). Clearing ALL.`);
                         localStorage.setItem('pro_cache_drift_time', String(driftTime));
                         ctx.cache.clear();
                         await ctx.db.clearAll();
                         ctx.broadcast({ type: 'ws-invalidate-all', timestamp: Date.now() });
                         ctx.enableCache();
                         return;
                     }

                     const keys = Object.keys(data);
                     if (keys.length === 0) {
                         ctx.log('[App] Manual: Full Sync - Empty Data -> Clearing ALL');
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

//wrap it inside the provider of your app
 <ProCacheProvider client={cache}>
        <App />
    </ProCacheProvider>
```

### Key Config Options

| Option | Description |
| :--- | :--- |
| `routeToCacheKey` | Transforms a dynamic URL (like `/todos/1`) into a generic key (`/todos/{id}`) for broad invalidation. |
| `handleMessage` | Intercept any socket message before it's processed. Gives access to `ctx.db`, `ctx.cache`, and `ctx.broadcast`. |
| `shouldInvalidate` | A predicate to determine if a specific key should be purged from cache based on incoming server data. |
| `getTimestamp` | Returns the authoritative server time (usually from headers). Essential for cache consistency. |

---

## 🎣 React Hooks

### `useLiveFetch`
The primary hook for data fetching. It automatically connects to the invalidation system.

```tsx
const { 
    data, 
    loading, 
    refetch, 
    isRefetching, 
    isRefetchNeeded 
} = useLiveFetch<Todo[]>('/todo/{id}',{ 
      params:{id:1},
      query:{orderBy:"asc"},
        autoRefetch: true // Manually testing this behavior now
    });
```

- **`data`**: The current value (from cache first, then API).
- **`loading`**: True during the **initial** fetch.
- **`isRefetching`**: True during **background** updates (socket-triggered or manual refetch).
- **`isRefetchNeeded`**: Returns `true` if an invalidation event was received but `autoRefetch` is disabled. Perfect for showing "New Data Available" banners.
- **`refetch({ force: true })`**: Bypasses the cache entirely to fetch fresh data from the server.

### `useProCacheStatus`
Monitor the heartbeat of the library:

```tsx
const { wsStatus, isLeaderTab, isCacheEnabled, isDebugEnabled } = useProCacheStatus();
```

---

## 🛠 Manual State Control

You can bind keyboard shortcuts or UI toggles to manage the library state globally.

```tsx
import { useToggleCaching, useProCache } from 'pro_cache';

function App() {
    const { toggle } = useToggleCaching();
    const client = useProCache();

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.key === 'k') toggle(); // Toggle Cache
            if (e.ctrlKey && e.shiftKey && e.key === 'D') {
                client.socket.setDebug(!client.socket.debugStatus());
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, []);
}
```

---

## 📦 Publishing

1. `npm run build`
2. `npm login`
3. `npm publish --access public`

---

## License
MIT
