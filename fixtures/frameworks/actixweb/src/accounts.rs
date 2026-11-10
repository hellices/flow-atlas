use actix_web::{HttpResponse, Responder, web};

/// Mounted at `/accounts`: resources with their methods, written without macros.
pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("").route(web::get().to(list)).route(web::post().to(create)))
        .service(
            web::resource("/{account_id}")
                .route(web::get().to(show))
                .route(web::delete().to(HttpResponse::NoContent)),
        );
}

async fn list() -> impl Responder {
    "accounts"
}

async fn create() -> HttpResponse {
    HttpResponse::Created().finish()
}

async fn show(path: web::Path<String>) -> String {
    path.into_inner()
}
