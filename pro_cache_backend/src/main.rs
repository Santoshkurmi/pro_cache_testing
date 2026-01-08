mod handlers;
mod state;
mod ws;

use actix_web::{web, App, HttpServer, middleware};
use actix_web::dev::Service;
use futures_util::future::{ok, Either};
use state::AppState;

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
            .wrap(actix_cors::Cors::permissive())
            .wrap(middleware::Logger::default())
            // Public WebSocket Endpoint
            .route("/ws", web::get().to(ws::ws_handler))
            // Internal API Handlers (Protected by being on local interface in production via separate bind if desired)
            // Ideally we separate them completely, but for "simple" project, route separation is fine.
            // Using a scope for clarity
            .service(
                web::scope("/internal")
                    .wrap_fn(|req, srv| {
                        let is_local = req.peer_addr().map_or(false, |addr| {
                            let ip = addr.ip();
                            ip.is_loopback() || ip.to_string() == "127.0.0.1" || ip.to_string() == "::1"
                        });

                        if is_local {
                            Either::Left(srv.call(req))
                        } else {
                            // Return nothing/NotFound to pretend it doesn't exist
                            log::warn!("[Security] Blocking non-local internal access from: {:?}", req.peer_addr());
                            let res = req.into_response(actix_web::HttpResponse::NotFound().finish());
                            Either::Right(ok(res.map_into_boxed_body()))
                        }
                    })
                    .route("/auth/register", web::post().to(handlers::register_token))
                    .route("/invalidate", web::post().to(handlers::invalidate))
            )
    })
    .bind(("0.0.0.0", 8080))? // Public access
    .bind(("127.0.0.1", 8081))? // Internal access (could be same port but separate is cleaner for firewall rules)
    .run()
    .await
}
