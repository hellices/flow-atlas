use actix_web::{HttpResponse, delete, get, post, put, web};

/// Mounted at `/api`.
pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(health).service(
        web::scope("/v1")
            .service(list_users)
            .service(create_user)
            .service(show_user)
            .service(update_user)
            .service(delete_user)
            .service(web::scope("/users/{id}/posts").service(show_post).route("", web::get().to(HttpResponse::Ok))),
    );
}

#[get("/health")]
async fn health() -> &'static str {
    "ok"
}

#[get("/users")]
async fn list_users() -> &'static str {
    "users"
}

#[post("/users")]
async fn create_user() -> HttpResponse {
    HttpResponse::Created().finish()
}

#[get("/users/{id}")]
async fn show_user(path: web::Path<u32>) -> String {
    path.to_string()
}

#[put("/users/{id}")]
async fn update_user(path: web::Path<u32>) -> String {
    path.to_string()
}

#[delete("/users/{id}")]
async fn delete_user(path: web::Path<u32>) -> HttpResponse {
    let _ = path;
    HttpResponse::NoContent().finish()
}

#[get("/{post_id}")]
async fn show_post(path: web::Path<(u32, u32)>) -> String {
    let (id, post_id) = path.into_inner();
    format!("{id}/{post_id}")
}
