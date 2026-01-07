use actix_web::{web, HttpResponse, Responder};
use crate::state::{AppState, RegisterTokenRequest, InvalidateRequest, TokenData};
use std::time::Instant;

pub async fn register_token(
    data: web::Data<AppState>,
    req: web::Json<RegisterTokenRequest>,
) -> impl Responder {
    let token_data = TokenData {
        user_id: req.user_id.clone(),
        project_id: req.project_id.clone(),
        created_at: Instant::now(),
        ttl: req.ttl.unwrap_or(86400), // Default 24 hours
    };

    // 1. Check if user already has a token for this project
    let user_key = (req.project_id.clone(), req.user_id.clone());
    if let Some(old_token) = data.user_tokens.get(&user_key) {
        // Remove the old token from pending_tokens (valid_tokens)
        data.pending_tokens.remove(old_token.value());
    }

    // 2. Register the new token
    data.pending_tokens.insert(req.token.clone(), token_data);
    data.user_tokens.insert(user_key, req.token.clone());

    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "message": "Token registered"
    }))
}

pub async fn invalidate(
    data: web::Data<AppState>,
    req: web::Json<InvalidateRequest>,
) -> impl Responder {
    let project_id = &req.project_id;
    let path = &req.path;
    
    // 0. Register route if new
    if !data.known_routes.contains_key(path) {
        data.known_routes.insert(path.clone(), ());
        // Save to file (in a real app, might want to debounce or do async)
        data.save_routes();
    }
    
    // 1. Update Invalidation State
    let timestamp = chrono::Utc::now().timestamp_millis();
    
    data.project_invalidation_state
        .entry(project_id.clone())
        .or_insert_with(dashmap::DashMap::new)
        .insert(path.clone(), timestamp);

    // 2. Broadcast Delta
    let message = serde_json::json!({
        "type": "invalidate-delta",
        "data": {
            path: timestamp
        }
    });
    
    let msg_str = match serde_json::to_string(&message) {
        Ok(s) => s,
        Err(e) => return HttpResponse::InternalServerError().body(e.to_string()),
    };

    let mut count = 0;

    if let Some(project_sessions) = data.active_sessions.get(project_id) {
        for entry in project_sessions.iter() {
            let _session_id = entry.key();
            let session_data = entry.value();
            
            // Filter by user_id if provided
            if let Some(target_user) = &req.user_id {
                if &session_data.user_id != target_user {
                    continue;
                }
            }
            
            // Sending message
            let _ = session_data.sender.send(msg_str.clone());
            count += 1;
        }
    }

    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "broadcast_count": count
    }))
}
