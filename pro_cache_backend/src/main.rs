mod handlers;
mod state;
mod ws;

use actix_web::{web, App, HttpServer, middleware};
use state::AppState;
use std::sync::Arc;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let state = web::Data::new(AppState::new());

    log::info!("Starting pro_cache_backend...");
    log::info!("Internal API listening on 127.0.0.1:8081");
    log::info!("Public WS listening on 0.0.0.0:8080");

    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .wrap(middleware::Logger::default())
            // Public WebSocket Endpoint
            .route("/ws", web::get().to(ws::ws_handler))
            // Internal API Handlers (Protected by being on local interface in production via separate bind if desired)
            // Ideally we separate them completely, but for "simple" project, route separation is fine.
            // Using a scope for clarity
            .service(
                web::scope("/internal")
                    .route("/auth/register", web::post().to(handlers::register_token))
                    .route("/invalidate", web::post().to(handlers::invalidate))
            )
    })
    .bind(("0.0.0.0", 8080))? // Public access
    .bind(("127.0.0.1", 8081))? // Internal access (could be same port but separate is cleaner for firewall rules)
    .run()
    .await
}
