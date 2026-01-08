import { createSignal, type Accessor, type Setter } from 'solid-js';
import { CacheManager } from './cache';
import { IndexedDBCache } from './db';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'offline';

export type WSMessage = 
    | { type: 'ws-invalidate', key: string, timestamp: number }
    | { type: 'ws-invalidate-all', timestamp: number }
    | { type: 'ws-status', status: ConnectionStatus }
    | { type: 'leader-claim', tabId: string }
    | { type: 'leader-query' }
    | { type: 'leader-stepdown', oldLeaderId: string }
    | { type: 'ws-upstream', payload: any }
    | { type: 'ws-custom', payload: any }
    | { type: 'network-offline' }
    | { type: 'network-online' }
    | { type: 'ws-cache-enabled', enabled: boolean, explicitlyClosed?: boolean }
    | { type: 'ws-debug-enabled', enabled: boolean };

export interface WebSocketContext {
    db: IndexedDBCache;
    cache: CacheManager;
    broadcast: (message: any) => void;
    triggerSubscribers: (key: string) => void;
    pollSubscribers: (key: string) => void;
    routeToCacheKey: (path: string) => string;
    invalidateExcept: (validKeys: string[]) => Promise<void>;
    enableCache: () => void;  // Enable cache after sync is complete
    log: (...args: any[]) => void;
}

export interface WebSocketConfig {
    url: string | (() => string);
    channelName?: string;
    routeToCacheKey?: (routePath: string) => string;
    defaultBackgroundDelay?: number; // Configurable default
    backgroundPollInterval?: number; // Configurable poll interval
    activityIndicatorDuration?: number; // Duration in ms for activity indicator (default: 2500)
    debug?: boolean; // Enable debug logging
    shouldInvalidate?: (key: string, value: any, db: IndexedDBCache) => Promise<boolean> | boolean;
    handleMessage?: (msg: any, ctx: WebSocketContext, defaultHandler: (msg: any) => Promise<void>) => Promise<void>;
    startup?: {
        enableCacheBeforeSocket?: boolean;
        waitForSocket?: boolean;
        socketWaitTimeout?: number;
    };
}

export class WebSocketClient {
    // Signals
    public wsStatus: Accessor<ConnectionStatus>;
    public setWsStatus: Setter<ConnectionStatus>;
    public recentActivity: Accessor<boolean>;
    public setRecentActivity: Setter<boolean>;
    public isLeaderTab: Accessor<boolean>;
    public setIsLeaderTab: Setter<boolean>;
    public isOnline: Accessor<boolean>;
    public setIsOnline: Setter<boolean>;
    public isCacheEnabled: Accessor<boolean>;
    public setIsCacheEnabled: Setter<boolean>;
    public debugStatus: Accessor<boolean>;
    public setDebugStatus: Setter<boolean>;

    private ws: WebSocket | null = null;
    private reconnectAttempts = 0;
    private reconnectTimeout: number | null = null;
    private isExplicitlyClosed = false;
    private callbacks: Map<string, ((key: string) => void)[]> = new Map();
    private globalInvalidationCallbacks: (() => void)[] = [];
    private customListeners: Map<string, ((payload: any) => void)[]> = new Map();
    
    // Per-route delay configuration
    private routeDelays: Map<string, number> = new Map();
    
    // Dependencies
    private cacheManager: CacheManager;
    private db: IndexedDBCache;
    private config: WebSocketConfig;
    
    // Defaults
    private readonly DEFAULT_DELAY = 500;
    private readonly DEFAULT_POLL_INTERVAL = 200;
    
    // Debug-aware logging
    public log(...args: any[]) {
        if (this.debugStatus()) {
            console.log(...args);
        }
    }
    
    // Set debug mode at runtime
    public setDebug(enabled: boolean) {
        this.setDebugStatus(enabled);
        this.channel?.postMessage({ type: 'ws-debug-enabled', enabled } as WSMessage);
    }

    /**
     * Update cache enabled status and broadcast to other tabs
     */
    public updateCacheEnabled(enabled: boolean) {
        this.setIsCacheEnabled(enabled);
        const prev = this.isExplicitlyClosed;
        this.isExplicitlyClosed = !enabled;
        
        if (prev !== this.isExplicitlyClosed) {
            this.log(`[WS] Explicit closure changed: ${prev} -> ${this.isExplicitlyClosed} (via updateCacheEnabled)`);
        }

        this.channel?.postMessage({ 
            type: 'ws-cache-enabled', 
            enabled, 
            explicitlyClosed: this.isExplicitlyClosed 
        } as WSMessage);
    }

    // Leader election
    private tabId: string = Math.random().toString(36).substring(7);
    private isLeader = false;
    private channel: BroadcastChannel | null = null;
    private leaderCheckInterval: number | null = null;
    private pendingLeaderCheck = false;
    private leaderCheckResolve: (() => void) | null = null;
    
    // Follower heartbeat tracking
    private lastLeaderHeartbeat: number = 0;
    private followerCheckInterval: number | null = null;
    private readonly LEADER_TIMEOUT = 5000; // 5 seconds without heartbeat = leader gone (User Requested)
    
    // localStorage keys for instant leader detection
    private readonly LEADER_KEY = 'ws-leader-tab';
    private readonly LEADER_HEARTBEAT_KEY = 'ws-leader-heartbeat';

    constructor(cacheManager: CacheManager, db: IndexedDBCache, config: WebSocketConfig) {
        this.cacheManager = cacheManager;
        this.db = db;
        this.config = config;

        // 1. Initialize and assign signals FIRST so they are available for logging
        const [wsStatus, setWsStatus] = createSignal<ConnectionStatus>('disconnected');
        const [recentActivity, setRecentActivity] = createSignal(false);
        const [isLeaderTab, setIsLeaderTab] = createSignal(false);
        const [isOnline, setIsOnline] = createSignal(typeof navigator !== 'undefined' ? navigator.onLine : true);
        const [debugStatus, setDebugStatus] = createSignal(config.debug ?? false);
        
        const initialCacheEnabled = config.startup?.enableCacheBeforeSocket !== false;
        const [isCacheEnabled, setIsCacheEnabled] = createSignal(initialCacheEnabled);

        this.wsStatus = wsStatus;
        this.setWsStatus = setWsStatus;
        this.recentActivity = recentActivity;
        this.setRecentActivity = setRecentActivity;
        this.isLeaderTab = isLeaderTab;
        this.setIsLeaderTab = setIsLeaderTab;
        this.isOnline = isOnline;
        this.setIsOnline = setIsOnline;
        this.isCacheEnabled = isCacheEnabled;
        this.setIsCacheEnabled = setIsCacheEnabled;
        this.debugStatus = debugStatus;
        this.setDebugStatus = setDebugStatus;

        // 2. NOW we can safely log
        this.log(`[WS] Initializing tab ${this.tabId} (Leader-to-be if first)`);

        if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
            this.channel = new BroadcastChannel(config.channelName || 'pro-cache-ws-sync');
            this.channel.onmessage = (event: MessageEvent<WSMessage>) => {
                this.handleBroadcast(event.data);
            };
        }
        
        // Network status detection
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => this.handleNetworkOnline());
            window.addEventListener('offline', () => this.handleNetworkOffline());
            
            // Clear localStorage when leader tab closes/refreshes
            window.addEventListener('beforeunload', () => {
                if (this.isLeader) {
                    // Notify followers immediately to start election
                    this.channel?.postMessage({ type: 'leader-stepdown', oldLeaderId: this.tabId } as WSMessage);
                    this.clearLeaderStorage();
                }
            });
        }
    }
    
    // Public API to start connection logic
    public async connect() {
        this.log(`[WS] Manual connect() called - resetting isExplicitlyClosed from ${this.isExplicitlyClosed} to false`);
        this.isExplicitlyClosed = false;
        await this.becomeLeader();
    }

    public disconnect() {
        console.log("Disconnecting")
        this.isExplicitlyClosed = true;
        this.stepDown();
    }

    /**
     * Wait for WebSocket connection with timeout
     */
    public waitForConnection(timeout: number): Promise<boolean> {
        if (this.wsStatus() === 'connected') {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            let timer: number | null = null;
            
            const check = () => {
                if (this.wsStatus() === 'connected') {
                    if (timer) clearTimeout(timer);
                    resolve(true);
                }
            };

            // Use an interval or reactive effect? Effect is better given we have signals.
            // But we can't createEffect here easily without root tracking leak?
            // Simple polling for this one-off is safe enough.
            const interval = setInterval(check, 50);

            timer = window.setTimeout(() => {
                clearInterval(interval);
                resolve(false);
            }, timeout);
            
            // Cleanup interval on success
            const originalResolve = resolve;
            resolve = (val) => {
                clearInterval(interval);
                originalResolve(val);
            };
        });
    }
    
    /**
     * Send data to the WebSocket.
     * If this tab is the Leader, it sends it directly.
     * If this tab is a Follower, it forwards it to the Leader via BroadcastChannel.
     */
    public send(data: any) {
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        
        if (this.isLeader) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(payload);
            } else {
                console.warn('[WS] Cannot send message, WebSocket not connected');
            }
        } else {
            this.log('[WS] Forwarding message to Leader');
            this.channel?.postMessage({ type: 'ws-upstream', payload: tryParse(payload) } as WSMessage);
        }
    }
    
    /**
     * Listen for custom server messages (based on 'type' field in JSON)
     */
    public on(type: string, callback: (payload: any) => void): () => void {
        if (!this.customListeners.has(type)) {
            this.customListeners.set(type, []);
        }
        this.customListeners.get(type)!.push(callback);
        
        return () => {
             const listeners = this.customListeners.get(type);
             if (listeners) {
                 const idx = listeners.indexOf(callback);
                 if (idx > -1) listeners.splice(idx, 1);
             }
        };
    }
    
    public off(type: string, callback: (payload: any) => void) {
        const listeners = this.customListeners.get(type);
        if (listeners) {
            const idx = listeners.indexOf(callback);
            if (idx > -1) listeners.splice(idx, 1);
        }
    }

    private startFollowerHeartbeatCheck() {
        // Stop any existing interval
        if (this.followerCheckInterval) {
            clearInterval(this.followerCheckInterval);
        }
        
        // Check every 2 seconds (faster check due to 5s timeout)
        this.followerCheckInterval = window.setInterval(() => {
            if (this.isLeader) {
                // We're the leader now, stop checking
                this.stopFollowerHeartbeatCheck();
                return;
            }
            
            // Request status from leader (leader will respond with ws-status)
            this.channel?.postMessage({ type: 'leader-query' } as WSMessage);
            
            const timeSinceLastHeartbeat = Date.now() - this.lastLeaderHeartbeat;
            if (timeSinceLastHeartbeat > this.LEADER_TIMEOUT) {
                this.log(`[WS Follower] Leader timeout (${timeSinceLastHeartbeat}ms), attempting to become leader`);
                this.stopFollowerHeartbeatCheck();
                this.becomeLeader();
            }
        }, 2000);
    }
    
    private stopFollowerHeartbeatCheck() {
        if (this.followerCheckInterval) {
            clearInterval(this.followerCheckInterval);
            this.followerCheckInterval = null;
        }
    }
    
    private handleNetworkOffline() {
        this.log('[Network] Browser went OFFLINE');
        this.setIsOnline(false);
        this.setWsStatus('offline');
        
        // Note: Cache is NOT cleared - just disabled via isCacheEnabled
        
        // Broadcast to other tabs
        this.channel?.postMessage({ type: 'network-offline' } as WSMessage);
        this.broadcastStatus('offline');
        
        // Disconnect WebSocket
        if (this.isLeader && this.ws) {
            this.disconnectWebSocket();
        }
    }
    
    private handleNetworkOnline() {
        this.log('[Network] Browser went ONLINE');
        this.setIsOnline(true);
        
        // Broadcast to other tabs
        this.channel?.postMessage({ type: 'network-online' } as WSMessage);
        
        // Reconnect WebSocket if leader
        if (this.isLeader) {
            this.reconnectAttempts = 0; // Reset attempts
            this.connectWebSocket();
        }
        
        // Trigger global invalidation callbacks to refetch data
        this.globalInvalidationCallbacks.forEach(cb => cb());
    }

    private async pollForCache(key: string, callbacks: ((k:string)=>void)[]) {
        const maxWait = this.getDelay(key);
        const pollInterval = this.config.backgroundPollInterval ?? this.DEFAULT_POLL_INTERVAL;
        const startTime = Date.now();

        this.log(`[WS] Background polling started for ${key} (Max: ${maxWait}ms, Interval: ${pollInterval}ms)`);

        const check = async () => {
            // Check if cache populated (by other tab via BroadcastChannel or IDB)
            const isFocused = typeof document !== 'undefined' && document.hasFocus();
            if(isFocused){
                this.log(`[WS] Background polling stopped and fetched due to focus of the tab! Cache populated for ${key}`);
                callbacks.forEach(cb => cb(key));
                return;
            }
            const data = await this.cacheManager.find(key);
            
            if (data) {
                this.log(`[WS] Background polling success! Cache populated for ${key}`);
                callbacks.forEach(cb => cb(key));
                return;
            }

            if (Date.now() - startTime >= maxWait) {
                this.log(`[WS] Background polling timed out (${maxWait}ms), forcing fetch for ${key}`);
                callbacks.forEach(cb => cb(key));
                return;
            }

            // Retry after interval
            setTimeout(check, pollInterval);
        };
        
        // Initial wait to give active tab a head start
        setTimeout(check, pollInterval);
    }

    private handleBroadcast(msg: WSMessage) {
        if (msg.type === 'ws-invalidate-all') {
            if (!this.isLeader) {
                this.log('[WS Follower] Received "all" invalidation from leader');
                this.cacheManager.clear();
                // Leader cleared DB, so we are good.
                
                // Trigger ALL callbacks to refetch
                this.setRecentActivity(true);
                setTimeout(() => this.setRecentActivity(false), this.config.activityIndicatorDuration ?? 2500);
                
                this.globalInvalidationCallbacks.forEach(cb => cb());
                this.callbacks.forEach((list, key) => {
                     // Check if active or poll?
                     // For 'all', polling is hard. We just trigger.
                     // Active tabs will fetch. Background tabs will just have cleared cache.
                     list.forEach(cb => cb(key));
                });
            }
        } else if (msg.type === 'ws-invalidate') {
            // Non-leader tabs receive invalidation from leader
            // DON'T invalidate cache here - leader already cached fresh data
            // Just trigger callbacks to refetch (will hit cache)
            if (!this.isLeader) {
                this.log(`[WS Follower] Data update from leader: ${msg.key}`);
                
                // Trigger activity animation
                this.setRecentActivity(true);
                setTimeout(() => this.setRecentActivity(false), this.config.activityIndicatorDuration ?? 2500);
                
                // Trigger callbacks - they will refetch and get cache hit
                const callbacks = this.callbacks.get(msg.key) || [];
                
                const isFocused = typeof document !== 'undefined' && document.hasFocus();
                
                if (isFocused) {
                    // We are active - Refetch immediately
                    this.log(`[WS Follower] Active tab - triggering refetch immediately`);
                    callbacks.forEach(cb => cb(msg.key));
                } else {
                    // We are background - Poll for cache update from active tab
                    this.pollForCache(msg.key, callbacks);
                }
            }
        } else if (msg.type === 'ws-status') {
            // Sync status from leader
            if (!this.isLeader) {
                this.setWsStatus(msg.status);
            }
        } else if (msg.type === 'network-offline') {
            // Leader detected network offline
            this.log('[WS Follower] Network offline notification from leader');
            this.setIsOnline(false);
            this.setWsStatus('offline');
        } else if (msg.type === 'network-online') {
            // Leader detected network online
            this.log('[WS Follower] Network online notification from leader');
            this.setIsOnline(true);
            // Trigger global invalidation callbacks to refetch data
            this.globalInvalidationCallbacks.forEach(cb => cb());
        } else if (msg.type === 'ws-cache-enabled') {
            this.setIsCacheEnabled(msg.enabled);
            if (msg.explicitlyClosed !== undefined) {
                if (this.isExplicitlyClosed !== msg.explicitlyClosed) {
                    this.log(`[WS] Updating isExplicitlyClosed to ${msg.explicitlyClosed} from remote message`);
                }
                this.isExplicitlyClosed = msg.explicitlyClosed;
            }
            
            // If we are leader, ensure WebSocket status matches cache status
            if (this.isLeader) {
                if (msg.enabled && !this.isExplicitlyClosed) {
                    this.log('[WS Leader] Enabling WebSocket due to remote cache-enable command');
                    this.connectWebSocket();
                } else if (!msg.enabled) {
                    this.log('[WS Leader] Disconnecting WebSocket due to remote cache-disable command');
                    this.disconnectWebSocket();
                }
            }
        } else if (msg.type === 'ws-debug-enabled') {
            this.setDebugStatus(msg.enabled);
        } else if (msg.type === 'leader-stepdown') {
            // Current leader is stepping down specifically (e.g. tab closed)
            // Instant election trigger
            if (!this.isLeader && this.lastLeaderHeartbeat > 0) {
                 this.log(`[WS] Received leader stepdown from ${msg.oldLeaderId}, starting election immediately`);
                 // Force timeout condition essentially
                 this.stopFollowerHeartbeatCheck();
                 this.becomeLeader();
            }
        } else if (msg.type === 'leader-claim') {
            // Another tab claims leadership - update heartbeat
            if (msg.tabId !== this.tabId) {
                // Update heartbeat timestamp
                this.lastLeaderHeartbeat = Date.now();
                
                if (this.isLeader) {
                    this.log(`[WS] Another tab (${msg.tabId}) claimed leadership, stepping down`);
                    this.stepDown();
                    // Start monitoring the new leader
                    this.startFollowerHeartbeatCheck();
                } else if (this.pendingLeaderCheck) {
                    // We were checking for leaders - found one!
                    this.log(`[WS] Tab ${this.tabId} found existing leader (${msg.tabId}), staying as FOLLOWER`);
                    this.pendingLeaderCheck = false;
                    this.leaderCheckResolve?.();
                    // Start monitoring the leader
                    this.startFollowerHeartbeatCheck();
                }
                
                // Safety check: If we somehow have a WebSocket but aren't leader, close it
                if (!this.isLeader && this.ws) {
                    this.log(`[WS] Tab ${this.tabId} has orphan WebSocket, closing it`);
                    this.disconnectWebSocket();
                }
            }
        } else if (msg.type === 'leader-query') {
            // A new tab is asking if there's a leader
            if (this.isLeader) {
                // Respond with leadership claim (debug level since this is frequent)
                console.debug(`[WS Leader] Responding to leadership query`);
                this.channel?.postMessage({ type: 'leader-claim', tabId: this.tabId } as WSMessage);
                
                // Ensure WebSocket is connected (might have failed to connect when becoming leader)
                // ONLY connect if not explicitly closed and caching is supposed to be ON
                if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
                    if (!this.isExplicitlyClosed && this.isCacheEnabled()) {
                        this.log('[WS Leader] WebSocket not connected, attempting to connect...');
                        this.connectWebSocket();
                    } else {
                        this.log('[WS Leader] Skipping auto-connect during leader-query: Caching disabled or explicitly closed');
                    }
                }
                
                // Broadcast current WebSocket status so follower knows connection state
                this.channel?.postMessage({ type: 'ws-status', status: this.wsStatus() } as WSMessage);
                this.channel?.postMessage({ 
                    type: 'ws-cache-enabled', 
                    enabled: this.isCacheEnabled(),
                    explicitlyClosed: this.isExplicitlyClosed
                } as WSMessage);
                this.channel?.postMessage({ type: 'ws-debug-enabled', enabled: this.debugStatus() } as WSMessage);
            }
        } else if (msg.type === 'ws-upstream') {
            // Leader received message from Follower to send to server
            if (this.isLeader) {
                this.log('[WS Leader] Relaying upstream message from follower');
                this.send(msg.payload);
            }
        } else if (msg.type === 'ws-custom') {
            // Follower received custom message relayed by Leader
            if (!this.isLeader) {
                const payload = msg.payload;
                if (payload && payload.type) {
                     const listeners = this.customListeners.get(payload.type);
                     if (listeners) {
                         listeners.forEach(cb => cb(payload));
                     }
                }
            }
        }
    }

    private becomeLeader() {
        if (this.isLeader) return Promise.resolve();
        
        // INSTANT CHECK: Check localStorage for existing leader
        const storedLeader = localStorage.getItem(this.LEADER_KEY);
        const storedHeartbeat = localStorage.getItem(this.LEADER_HEARTBEAT_KEY);
        
        if (storedLeader && storedHeartbeat) {
            const heartbeatAge = Date.now() - parseInt(storedHeartbeat, 10);
            if (heartbeatAge < this.LEADER_TIMEOUT && storedLeader !== this.tabId) {
                // Leader exists and is recent - become follower immediately
                this.log(`[WS] Tab ${this.tabId} found existing leader (${storedLeader}) via localStorage - INSTANT follower`);
                this.lastLeaderHeartbeat = parseInt(storedHeartbeat, 10);
                this.startFollowerHeartbeatCheck();
                
                // Request current status from leader
                this.channel?.postMessage({ type: 'leader-query' } as WSMessage);
                
                return Promise.resolve();
            }
        }
        
        // No valid leader in localStorage - do quick BroadcastChannel check
        return new Promise<void>((resolve) => {
            this.pendingLeaderCheck = true;
            this.leaderCheckResolve = resolve;
            
            // Send query for existing leader
            this.log(`[WS] Tab ${this.tabId} sending leader query...`);
            this.channel?.postMessage({ type: 'leader-query' } as WSMessage);
            
            // Wait for leader response
            setTimeout(() => {
                if (this.pendingLeaderCheck) {
                    // Double-check localStorage before becoming leader (race condition prevention)
                    const storedLeader = localStorage.getItem(this.LEADER_KEY);
                    const storedHeartbeat = localStorage.getItem(this.LEADER_HEARTBEAT_KEY);
                    
                    if (storedLeader && storedHeartbeat && storedLeader !== this.tabId) {
                        const heartbeatAge = Date.now() - parseInt(storedHeartbeat, 10);
                        if (heartbeatAge < this.LEADER_TIMEOUT) {
                            // A leader appeared while we were waiting - become follower
                            this.log(`[WS] Tab ${this.tabId} found leader in localStorage during election, becoming follower`);
                            this.pendingLeaderCheck = false;
                            this.lastLeaderHeartbeat = parseInt(storedHeartbeat, 10);
                            this.startFollowerHeartbeatCheck();
                            resolve();
                            return;
                        }
                    }
                    
                    // No valid leader, become leader
                    this.pendingLeaderCheck = false;
                    this.isLeader = true;
                    this.setIsLeaderTab(true);
                    this.log(`[WS] Tab ${this.tabId} became LEADER`);
                    
                    // Store leadership in localStorage for instant detection
                    this.updateLeaderStorage();
                    
                    // Stop follower heartbeat check since we're leader now
                    this.stopFollowerHeartbeatCheck();
                    
                    // Broadcast leadership claim
                    this.channel?.postMessage({ type: 'leader-claim', tabId: this.tabId } as WSMessage);
                    
                    // Connect WebSocket (only if we're still the leader)
                    if (this.isLeader) {
                        this.connectWebSocket();
                    }
                    
                    // Periodic leadership ping and localStorage update
            this.leaderCheckInterval = window.setInterval(() => {
                if (this.isLeader) {
                    this.channel?.postMessage({ type: 'leader-claim', tabId: this.tabId } as WSMessage);
                    this.updateLeaderStorage();
                }
            }, 2000); // 2 seconds ping (faster update)
                    
                    resolve();
                }
                // If pendingLeaderCheck is false, handleBroadcast already resolved
            }, 150); // Increased timeout for more reliable BroadcastChannel delivery
        });
    }
    
    private updateLeaderStorage() {
        localStorage.setItem(this.LEADER_KEY, this.tabId);
        localStorage.setItem(this.LEADER_HEARTBEAT_KEY, Date.now().toString());
    }
    
    private clearLeaderStorage() {
        const storedLeader = localStorage.getItem(this.LEADER_KEY);
        if (storedLeader === this.tabId) {
            localStorage.removeItem(this.LEADER_KEY);
            localStorage.removeItem(this.LEADER_HEARTBEAT_KEY);
        }
    }

    private stepDown() {
        if (!this.isLeader) return;
        
        this.log(`[WS] Tab ${this.tabId} stepping down from leadership`);
        this.isLeader = false;
        this.setIsLeaderTab(false);
        
        // Clear localStorage so new leader can be detected instantly
        this.clearLeaderStorage();
        
        if (this.leaderCheckInterval) {
            clearInterval(this.leaderCheckInterval);
            this.leaderCheckInterval = null;
        }
        
        this.disconnectWebSocket();
    }

    private connectWebSocket() {
        // Guard: Don't connect if explicitly closed
        if (this.isExplicitlyClosed) {
            this.log('[WS Leader] connectWebSocket aborted: isExplicitlyClosed is true');
            return;
        }

        // Only leader should connect WebSocket
        if (!this.isLeader) {
            console.warn(`[WS] Tab ${this.tabId} tried to connect WebSocket but is not leader`);
            return;
        }
        
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            console.debug('[WS Leader] WebSocket already connected/connecting, skipping');
            return;
        }
        
        // Clear any pending reconnect timeout to prevent duplicate connection attempts
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        this.isExplicitlyClosed = false;
        this.setWsStatus('connecting');
        this.broadcastStatus('connecting');

        const url = typeof this.config.url === 'function' ? this.config.url() : this.config.url;

        console.debug('[WS Leader] Connecting to', url);

        try {
            this.ws = new WebSocket(url);
        } catch(e) {
            console.error('[WS Leader] Failed to create WebSocket', e);
            this.setWsStatus('error');
            this.broadcastStatus('error');
            return;
        }

        this.ws.onopen = () => {
            console.debug('[WS Leader] Connected');
            this.setWsStatus('connected');
            this.broadcastStatus('connected');
            this.reconnectAttempts = 0;
            
            // NOTE: Do NOT enable cache here!
            // Cache should only be enabled AFTER the initial sync message is processed
            // to prevent serving stale data between connect and sync completion.
            // The handleMessage/handleBroadcast handlers will enable cache after sync.
        };

        this.ws.onclose = () => {

            this.setWsStatus('disconnected');
            this.broadcastStatus('disconnected');
            console.debug('[WS Leader] Disconnected');
            
            // Disable caching on disconnect/failure to force API usage
            // We NO LONGER clear cache, so data persists for offline usage or basic persistence
            this.log('[WS Leader] Disabling cache serving due to disconnect (Persistence Active)');
            
            this.setIsCacheEnabled(false);
            this.channel?.postMessage({ 
                type: 'ws-cache-enabled', 
                enabled: false, 
                explicitlyClosed: this.isExplicitlyClosed 
            } as WSMessage);
            
            if (!this.isExplicitlyClosed && this.isLeader) {
                this.scheduleReconnect();
            }
        };

        this.ws.onerror = (err) => {
            console.error('[WS Leader] Error', err);
            this.setWsStatus('error');
            this.broadcastStatus('error');
            
            // Disable caching on error to force API usage
            this.log('[WS Leader] Disabling cache serving due to error (Persistence Active)');
            
            this.setIsCacheEnabled(false);
            this.channel?.postMessage({ 
                type: 'ws-cache-enabled', 
                enabled: false, 
                explicitlyClosed: this.isExplicitlyClosed 
            } as WSMessage);
        };

        this.ws.onmessage = (event) => {
            // Trigger activity indicator for leader
            this.setRecentActivity(true);
            setTimeout(() => this.setRecentActivity(false), this.config.activityIndicatorDuration ?? 2500);
            
            try {
                // Handle raw string messages (e.g. "users.list")
                if (typeof event.data === 'string' && !event.data.startsWith('{') && !event.data.startsWith('[')) {
                    // It's a plain string key
                    console.debug('[WS Leader] Received raw string message:', event.data);
                    this.handleMessage({ type: 'invalidate', key: event.data });
                    return;
                }

                const msg = JSON.parse(event.data);
                this.handleMessage(msg);
            } catch (e) {
                console.warn('[WS Leader] Failed to parse message', event.data);
                // Fallback: treat as key if parse fails?
                // this.handleMessage({ type: 'invalidate', key: event.data });
            }
        };
    }

    private disconnectWebSocket() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
    }

    private broadcastStatus(status: ConnectionStatus) {
        this.channel?.postMessage({ type: 'ws-status', status } as WSMessage);
    }

    private scheduleReconnect() {
        // Don't reconnect if explicitly closed or caching disabled
        if (this.isExplicitlyClosed || !this.isCacheEnabled() || !this.isLeader) {
            this.log('[WS Leader] Skipping reconnect: status check failed', {
                isExplicitlyClosed: this.isExplicitlyClosed,
                cachingEnabled: this.isCacheEnabled(),
                isLeader: this.isLeader
            });
            return;
        }

        // Don't reconnect if offline
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            this.log('[WS Leader] Network offline, skipping reconnect');
            return;
        }

        // Progressive delay
        const delayTier = Math.floor(this.reconnectAttempts / 4);
        const delay = Math.min(5000 + (delayTier * 5000), 20000);
        
        this.reconnectAttempts++;
        console.debug(`[WS Leader] Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts})`);

        this.reconnectTimeout = window.setTimeout(() => {
            if (this.isLeader && navigator.onLine) {
                this.connectWebSocket();
            }
        }, delay);
    }

    private async handleMessage(msg: any) {
        if (this.config.handleMessage) {
            const ctx: WebSocketContext = {
                db: this.db,
                cache: this.cacheManager,
                broadcast: (message: any) => {
                    this.channel?.postMessage(message);
                },
                triggerSubscribers: (key: string) => {
                    const callbacks = this.callbacks.get(key) || [];
                    callbacks.forEach(cb => cb(key));
                },
                pollSubscribers: (key: string) => {
                    const callbacks = this.callbacks.get(key) || [];
                    this.pollForCache(key, callbacks);
                },
                routeToCacheKey: this.config.routeToCacheKey || ((p) => p),
                invalidateExcept: async (validKeys) => {
                    const allLocalBuckets = await this.db.getAllBucketKeys();
                    const validSet = new Set(validKeys);
                    if (allLocalBuckets) {
                        for (const localBucket of allLocalBuckets) {
                            if (!validSet.has(localBucket)) {
                                this.log(`[WS Leader] Sync deletion for: ${localBucket} (not in server list)`);
                                await this.invalidateAndNotify(localBucket, Date.now());
                            }
                        }
                    }
                },
                enableCache: () => {
                    if (this.isExplicitlyClosed) {
                        this.log('[WS] Custom handler tried to enable cache, but it is explicitly closed. Ignoring.');
                        return;
                    }
                    this.log('[WS] Custom handler enabling cache after sync');
                    this.updateCacheEnabled(true);
                },
                log: (...args: any[]) => this.log(...args)
            };
            await this.config.handleMessage(msg, ctx, (m) => this.defaultMessageHandler(m || msg));
        } else {
            await this.defaultMessageHandler(msg);
        }
    }

    private async defaultMessageHandler(msg: any) {
        
        // 1. Handle Full Sync: { type: 'invalidate', data: { [key]: timestamp, ... } }
        if (msg.type === 'invalidate' && typeof msg.data === 'object' && !Array.isArray(msg.data)) {
            this.log('[WS Leader] Received Full Sync "invalidate" message.');
            const data = msg.data as Record<string, number>;
            const serverKeys = new Set(Object.keys(data));

            // Case A: Empty Data -> Clear All
            if (serverKeys.size === 0) {
                 this.log('[WS Leader] Full Sync: Server state is empty. Clearing all local cache.');
                 this.cacheManager.clear();
                 await this.db.clearAll();
                 // Notify
                  this.channel?.postMessage({ type: 'ws-invalidate-all', timestamp: Date.now() } as WSMessage);
                  this.globalInvalidationCallbacks.forEach(cb => cb());
                  
                  if (!this.isExplicitlyClosed) {
                      this.updateCacheEnabled(true);
                  }
                  return;
             }

            // Case B: Non-Empty Data -> Sync
            // 1. Update items from Server (if newer)
            for (const [keyOrBucket, timestamp] of Object.entries(data)) {
                let shouldUpdate = true;
                if (this.config.shouldInvalidate) {
                     shouldUpdate = await this.config.shouldInvalidate(keyOrBucket, timestamp, this.db);
                } else {
                    const localTimestamp = await this.db.getTimestamp(keyOrBucket);
                    if (localTimestamp && localTimestamp >= timestamp) {
                         shouldUpdate = false;
                    }
                }

                if (shouldUpdate) {
                    this.log(`[WS Leader] Sync update for: ${keyOrBucket} at ${timestamp}`);
                    await this.invalidateAndNotify(keyOrBucket, timestamp);
                }
            }

            // 2. Delete items NOT in Server list (Sync)
            const allLocalBuckets = await this.db.getAllBucketKeys();
            if (allLocalBuckets) {
                for (const localBucket of allLocalBuckets) {
                    if (!serverKeys.has(localBucket)) {
                        this.log(`[WS Leader] Sync deletion for: ${localBucket} (not in server list)`);
                        await this.invalidateAndNotify(localBucket, Date.now()); 
                    }
                }
            }
            
            // Enable caching after full sync is complete
            this.log('[WS Leader] Full sync complete, enabling cache');
            if (!this.isExplicitlyClosed) {
                this.updateCacheEnabled(true);
            }
            return;
        }

        // 2. Handle Delta Update: { type: 'invalidate-delta', data: { [key]: timestamp } }
        if (msg.type === 'invalidate-delta' && typeof msg.data === 'object') {
             const data = msg.data as Record<string, number>;
             for (const [keyOrBucket, timestamp] of Object.entries(data)) {
                 this.log(`[WS Leader] Delta update for: ${keyOrBucket} at ${timestamp}`);
                 await this.invalidateAndNotify(keyOrBucket, timestamp);
             }
             return;
        }
        
        // Check for custom message types
        if (msg.type) {
             const listeners = this.customListeners.get(msg.type);
             if (listeners) {
                 this.log(`[WS Leader] Dispatching custom message: ${msg.type}`);
                 listeners.forEach(cb => cb(msg));
             }
             
             // Broadcast custom message to followers
             this.channel?.postMessage({ type: 'ws-custom', payload: msg } as WSMessage);
        }
    }

    // Helper to invalidate a bucket/key and notify all subscribers
    private async invalidateAndNotify(keyOrBucket: string, timestamp: number) {
         // 1. Invalidate Cache
        this.cacheManager.invalidate(keyOrBucket);
        
        // 2. Broadcast to followers
        this.channel?.postMessage({ type: 'ws-invalidate', key: keyOrBucket, timestamp } as WSMessage);
        
        // 3. Trigger Local Subscribers
        const callbacks = this.callbacks.get(keyOrBucket);
        if (callbacks && callbacks.length > 0) {
             if (typeof document !== 'undefined' && document.hasFocus()) {
                 this.log(`[WS Leader] Active tab - triggering subscribers immediately for ${keyOrBucket}`);
                 callbacks.forEach(cb => cb(keyOrBucket));
             } else {
                 this.log(`[WS Leader] Background tab - polling subscribers for ${keyOrBucket}`);
                 this.pollForCache(keyOrBucket, callbacks);
             }
        }
    }

    public onInvalidate(key: string, callback: (key: string) => void): () => void {
        if (!this.callbacks.has(key)) {
            this.callbacks.set(key, []);
        }
        this.callbacks.get(key)!.push(callback);

        return () => {
            const cbs = this.callbacks.get(key);
            if (cbs) {
                const index = cbs.indexOf(callback);
                if (index > -1) {
                    cbs.splice(index, 1);
                }
            }
        };
    }
    
    public onGlobalInvalidate(callback: () => void): () => void {
        this.globalInvalidationCallbacks.push(callback);
        
        return () => {
            const index = this.globalInvalidationCallbacks.indexOf(callback);
            if (index > -1) {
                this.globalInvalidationCallbacks.splice(index, 1);
            }
        };
    }
    
    public setRouteDelay(key: string, delay: number) {
        this.routeDelays.set(key, delay);
    }
    
    private getDelay(key: string): number {
        return this.routeDelays.get(key) ?? this.config.defaultBackgroundDelay ?? this.DEFAULT_DELAY;
    }
}

// Helper to safely parse potentially stringified JSON in upstream messages
function tryParse(str: string): any {
    try {
        return JSON.parse(str);
    } catch {
        return str;
    }
}
