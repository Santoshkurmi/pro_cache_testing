use actix_web::{web, Error, HttpRequest, HttpResponse};
// use actix_ws::AggregatedMessage;
use futures_util::{future, StreamExt as _};
use tokio::sync::mpsc;
use uuid::Uuid;
use crate::state::{AppState, SessionData};
use std::time::Instant;

pub async fn ws_handler(
    req: HttpRequest,
    stream: web::Payload,
    data: web::Data<AppState>,
) -> Result<HttpResponse, Error> {
    // 1. Extract Token from Query Params
    let query_str = req.query_string();
    let token = match form_urlencoded::parse(query_str.as_bytes())
        .find(|(k, _)| k == "token") 
    {
        Some((_, v)) => v.to_string(),
        None => return Ok(HttpResponse::Unauthorized().body("Missing token")),
    };

    // 2. Validate Token
    // We check if it exists in pending_tokens
    let token_data_opt = if let Some(entry) = data.pending_tokens.get(&token) {
        // Check TTL (if we wanted to enforce strictly, but for now just existence)
        Some(entry.clone())
    } else {
        None
    };

    let token_data = match token_data_opt {
        Some(t) => t,
        None => return Ok(HttpResponse::Unauthorized().body("Invalid or expired token")),
    };

    // Remove token from pending once used? 
    // User Update: "token is not one time, it will be for as long as it not chaneg again"
    // So we DO NOT remove it. 
    // data.pending_tokens.remove(&token);

    // 3. Upgrade to WebSocket
    let (res, mut session, mut stream) = actix_ws::handle(&req, stream)?;
    // Simple stream handling without explicit continuation aggregation for now
    // as it simplifies the verification step.

    let project_id = token_data.project_id.clone();
    let user_id = token_data.user_id.clone();
    let session_id = Uuid::new_v4();

    // 5. Send Initial Invalidation State
    // User Requirement: "if server restarted send to array 'all' string to know to clear all"
    
    let all_sync = serde_json::json!({
        "type": "invalidate",
        "data": {
            "all": data.server_start_time
        }
    });
    let _ = session.text(all_sync.to_string()).await;

    // 5. Create Channel for this session
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // 6. Register Session using DashMap
    // Ensure the inner map exists
    data.active_sessions
        .entry(project_id.clone())
        .or_insert_with(dashmap::DashMap::new)
        .insert(session_id, SessionData {
            user_id: user_id.clone(),
            sender: tx
        });

    let active_sessions = data.active_sessions.clone();
    let project_id_clone = project_id.clone();

    // 6. Spawn Actor/Task to handle the socket
    actix_rt::spawn(async move {
        // Send initial connection success message or similar if needed? 
        // For pro_cache, it might expect a status message.
        // session.text(serde_json::json!({ "type": "ws-status", "status": "connected" }).to_string()).await.unwrap();

        // Main Loop
        let mut rx_stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx);
        
        loop {
            tokio::select! {
                // Handle Incoming WebSocket Messages (from Client)
                msg_opt = stream.next() => {
                    match msg_opt {
                        Some(Ok(actix_ws::Message::Close(_))) => break,
                        Some(Ok(_)) => {}, 
                        Some(Err(_)) | None => break,
                    }
                }

                // Handle Outgoing Messages (from Internal API -> Channel -> Client)
                Some(msg) = rx_stream.next() => {
                    if session.text(msg).await.is_err() {
                        break;
                    }
                }
            }
        }

        // Cleanup
        if let Some(project_map) = active_sessions.get(&project_id_clone) {
            project_map.remove(&session_id);
            // If empty, we could remove the project map too, but DashMap inner deletion concurrency is tricky
            // Leaving empty map is fine for now.
        }
    });

    Ok(res)
}
