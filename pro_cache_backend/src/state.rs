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
    pub path: String,
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
        
        // Load routes from routes.json if exists
        if let Ok(content) = std::fs::read_to_string("routes.json") {
            if let Ok(routes) = serde_json::from_str::<Vec<String>>(&content) {
                for r in routes {
                    known_routes.insert(r, ());
                }
                log::info!("Loaded {} routes from routes.json", known_routes.len());
            }
        }

        AppState {
            pending_tokens: DashMap::new(),
            active_sessions: DashMap::new(),
            user_tokens: DashMap::new(),
            project_invalidation_state: DashMap::new(),
            known_routes,
            server_start_time: chrono::Utc::now().timestamp_millis(),
        }
    }

    pub fn save_routes(&self) {
        let routes: Vec<String> = self.known_routes.iter().map(|r| r.key().clone()).collect();
        if let Ok(json) = serde_json::to_string_pretty(&routes) {
            let _ = std::fs::write("routes.json", json);
        }
    }
}
