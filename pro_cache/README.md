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

export const cache = createProCache({
    debug: true,
    enabled: true,
    autoRefetchOnInvalidation: false, // Recommended: manual control
    db: {
        dbName: 'my_app_cache',
        dbVersion: 1
    },
    api: {
        baseUrl: 'https://api.myapp.com/api',
        defaultCacheTtl: 600
    },
    getTimestamp: (response) => {
        // CRITICAL: Extract server time to stay sync-safe
        return response.headers['x-server-timestamp'] || Date.now();
    },
    ws: {
        url: () => `ws://sock.myapp.com?token=${currentToken}`,
        
        // 1. Map route patterns to cache buckets
        routeToCacheKey: (routePath) => {
            // e.g., turn "/todos/123" into "/todos/{id}" for bucket invalidation
            return routePath.replace(/\/todos\/\d+/, '/todos/{id}');
        },

        // 2. Custom Message Middleware
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
        },

        // 3. Custom invalidation filter
        shouldInvalidate: async (key, value, db) => {
            const localTs = await db.getTimestamp(key);
            // Only invalidate if server timestamp is NEWER than local
            return !localTs || localTs < value;
        }
    }
});
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
