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

fn normalize_path(v: serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s,
        serde_json::Value::Number(n) => n.to_string(),
        _ => v.to_string(),
    }
}

pub async fn invalidate(
    data: web::Data<AppState>,
    req: web::Json<InvalidateRequest>,
) -> impl Responder {
    let project_id = &req.project_id;
    
    // 0. Extract and normalize all paths
    let mut target_paths = Vec::new();
    if let Some(p) = &req.path {
        target_paths.push(normalize_path(p.clone()));
    }
    if let Some(ps) = &req.paths {
        for p in ps {
            target_paths.push(normalize_path(p.clone()));
        }
    }
    
    if target_paths.is_empty() {
        return HttpResponse::BadRequest().body("No paths provided");
    }

    // 1. Coordinated Timestamp Generation & Clock Drift Detection (Short-lived lock)
    let (timestamp, drift_detected) = {
        let mut last_ts = data.last_global_timestamp.lock();
        let now = chrono::Utc::now().timestamp_millis();
        let prev = *last_ts;

        if prev > 0 && now < prev {
            log::warn!("[ClockDrift] Detected backward clock jump: {} -> {}. Triggering future-dated invalidations.", prev, now);
            *last_ts = 0; // Reset tracking
            (now, true)
        } else {
            *last_ts = now;
            (now, false)
        }
    };

    if drift_detected {
        let drift_now = chrono::Utc::now().timestamp_millis();
        data.last_drift_timestamp.store(drift_now, std::sync::atomic::Ordering::SeqCst);
        
        // 50 years in the future (ms) - to be safe
        let future_timestamp = drift_now + (50 * 365 * 24 * 60 * 60 * 1000);
        
        // Set ALL routes in ALL projects to this future timestamp
        // This ensures ANY client reconnecting will see local data as stale.
        for mut proj_entry in data.project_invalidation_state.iter_mut() {
             for mut route_entry in proj_entry.value_mut().iter_mut() {
                 *route_entry.value_mut() = future_timestamp;
             }
        }
        
        // Broadcast drift event to EVERYONE
        let reset_msg = serde_json::json!({
            "type": "invalidate",
            "data": {},
            "drift_time": drift_now
        }).to_string();
        
        for proj_entry in data.active_sessions.iter() {
            for sess_entry in proj_entry.value().iter() {
                let _ = sess_entry.value().sender.send(reset_msg.clone());
            }
        }
        
        return HttpResponse::Ok().json(serde_json::json!({
            "status": "clock_reset",
            "message": "System clock drift detected. BROADCAST: Future invalidations issued.",
            "drift_time": drift_now
        }));
    }

    // 2. Register routes if new (DashMap is thread-safe, no lock needed)
    let mut new_routes_found = false;
    for path in &target_paths {
        if !data.known_routes.contains_key(path) {
            data.known_routes.insert(path.clone(), ());
            new_routes_found = true;
        }
    }
    if new_routes_found {
        data.save_routes();
    }
    
    // 3. Update Invalidation State and Prepare Delta Message (DashMap is thread-safe)
    let mut delta_data = serde_json::Map::new();
    let current_drift = data.last_drift_timestamp.load(std::sync::atomic::Ordering::SeqCst);
    
    for path in &target_paths {
        data.project_invalidation_state
            .entry(project_id.clone())
            .or_insert_with(dashmap::DashMap::new)
            .insert(path.clone(), timestamp);
        
        delta_data.insert(path.clone(), serde_json::json!(timestamp));
    }

    let message = serde_json::json!({
        "type": "invalidate-delta",
        "data": delta_data,
        "drift_time": current_drift
    });
    
    let msg_str = match serde_json::to_string(&message) {
        Ok(s) => s,
        Err(e) => return HttpResponse::InternalServerError().body(e.to_string()),
    };

    let mut count = 0;

    // Broadcasting outside of any lock
    if let Some(project_sessions) = data.active_sessions.get(project_id) {
        for entry in project_sessions.iter() {
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
        "broadcast_count": count,
        "affected_paths": target_paths.len(),
        "timestamp": timestamp,
        "drift_time": current_drift
    }))
}
