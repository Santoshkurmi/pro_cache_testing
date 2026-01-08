use actix_web::{web, Error, HttpRequest, HttpResponse};
use futures_util::StreamExt as _;
use tokio::sync::mpsc;
use uuid::Uuid;
use crate::state::{AppState, SessionData};

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
    let token_data = match data.pending_tokens.get(&token) {
        Some(entry) => entry.clone(),
        None => return Ok(HttpResponse::Unauthorized().body("Invalid or expired token")),
    };

    // 3. Upgrade to WebSocket
    let (res, mut session, mut stream) = actix_ws::handle(&req, stream)?;

    let project_id = token_data.project_id.clone();
    let user_id = token_data.user_id.clone();
    let session_id = Uuid::new_v4();

    // 4. Send Initial Invalidation State
    let initial_routes: std::collections::HashMap<String, i64> = 
        if let Some(proj_map) = data.project_invalidation_state.get(&project_id) {
            proj_map.iter().map(|r| (r.key().clone(), *r.value())).collect()
        } else {
            std::collections::HashMap::new()
        };

    let all_sync = serde_json::json!({
        "type": "invalidate",
        "data": initial_routes
    });
    let _ = session.text(all_sync.to_string()).await;

    // 5. Create Channel for this session
    let (tx, rx) = mpsc::unbounded_channel::<String>();

    // 6. Register Session
    data.active_sessions
        .entry(project_id.clone())
        .or_insert_with(dashmap::DashMap::new)
        .insert(session_id, SessionData {
            user_id: user_id.clone(),
            sender: tx
        });

    let active_sessions = data.active_sessions.clone();
    let project_id_clone = project_id.clone();

    // 7. Spawn WebSocket Task
    actix_rt::spawn(async move {
        let mut rx_stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx);
        
        // We keep track of the close reason if the client sends one
        let mut close_reason = None;

        loop {
            tokio::select! {
                // Incoming messages from the Client
                msg_opt = stream.next() => {
                    match msg_opt {
                        Some(Ok(actix_ws::Message::Ping(bytes))) => {
                            if session.pong(&bytes).await.is_err() { break; }
                        }
                        Some(Ok(actix_ws::Message::Close(reason))) => {
                            close_reason = reason;
                            break; // Exit loop to handle session.close() once
                        }
                        Some(Err(_)) | None => break,
                        _ => {}
                    }
                }

                // Outgoing messages from Internal API
                msg_from_chan = rx_stream.next() => {
                    match msg_from_chan {
                        Some(msg) => {
                            if session.text(msg).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }

        // --- CLEANUP PHASE ---
        
        // This consumes `session`. Since we are outside the loop, 
        // it only happens once.
        let _ = session.close(close_reason).await;

        if let Some(project_map) = active_sessions.get(&project_id_clone) {
            project_map.remove(&session_id);
        }
    });

    Ok(res)
}