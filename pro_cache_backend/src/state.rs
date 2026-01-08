use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;
use std::time::Instant;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RegisterTokenRequest {
    pub token: String,
    pub user_id: String,
    pub project_id: String,
    pub ttl: Option<u64>, // Time to live in seconds
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InvalidateRequest {
    pub project_id: String,
    pub path: Option<serde_json::Value>, // Accepts String or Number
    pub paths: Option<Vec<serde_json::Value>>, // Accepts Array of Strings or Numbers
    pub user_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TokenData {
    pub user_id: String,
    pub project_id: String,
    pub created_at: Instant,
    pub ttl: u64,
}

#[derive(Debug)]
pub struct AppState {
    // Token -> TokenData
    pub pending_tokens: DashMap<String, TokenData>,
    
    // ProjectID -> { SessionID -> SessionData }
    pub active_sessions: DashMap<String, DashMap<Uuid, SessionData>>,

    // (ProjectID, UserID) -> Token
    // Used to find and invalidate old tokens when a user re-logins
    pub user_tokens: DashMap<(String, String), String>,

    // ProjectID -> { RoutePath -> Timestamp }
    // Stores the latest invalidation timestamp for each route in a project
    pub project_invalidation_state: DashMap<String, DashMap<String, i64>>,

    // Global set of known routes, persisted to routes.json
    pub known_routes: DashMap<String, ()>,
    
    // Last global timestamp received to detect clock drift (parking_lot for better performance)
    pub last_global_timestamp: parking_lot::Mutex<i64>,

    // Last time a clock drift was detected (or server start time)
    pub last_drift_timestamp: std::sync::atomic::AtomicI64,

    // Stable timestamp of when the server started
    pub server_start_time: i64,
}

#[derive(Debug, Clone)]
pub struct SessionData {
    pub user_id: String,
    pub sender: mpsc::UnboundedSender<String>,
}

impl AppState {
    pub fn new() -> self::AppState {
        let known_routes = DashMap::new();
        let project_invalidation_state = DashMap::new();
        let server_start_time = chrono::Utc::now().timestamp_millis();
        
        // Load routes from routes.json if exists
        if let Ok(content) = std::fs::read_to_string("routes.json") {
            if let Ok(routes) = serde_json::from_str::<Vec<String>>(&content) {
                for r in routes {
                    known_routes.insert(r.clone(), ());
                    
                    // The user wants these to be sent to frontend on restart with current timestamp
                    // We don't know the projects yet, so we can't pre-populate project_invalidation_state
                    // unless we assume a default project or just handle it in ws.rs when a project connects.
                }
                log::info!("Loaded {} routes from routes.json", known_routes.len());
            }
        }

        let state = AppState {
            pending_tokens: DashMap::new(),
            active_sessions: DashMap::new(),
            user_tokens: DashMap::new(),
            project_invalidation_state,
            known_routes,
            last_global_timestamp: parking_lot::Mutex::new(0),
            last_drift_timestamp: std::sync::atomic::AtomicI64::new(server_start_time),
            server_start_time,
        };

        // For first project ever or on restart, we can't pre-touch projects,
        // so we'll do that in ws.rs when someone connects.
        
        state
    }

    pub fn save_routes(&self) {
        let routes: Vec<String> = self.known_routes.iter().map(|r| r.key().clone()).collect();
        if let Ok(json) = serde_json::to_string_pretty(&routes) {
            let _ = std::fs::write("routes.json", json);
        }
    }
}
