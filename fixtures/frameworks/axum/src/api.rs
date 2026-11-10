use axum::{
    Json, Router,
    extract::Path,
    routing::{get, post},
};

use super::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(index))
        .nest("/v1", v1())
        .nest("/v2", Router::new().route("/users/{id}", get(show_user_v2)))
}

fn v1() -> Router<AppState> {
    Router::new()
        .route("/users", get(list_users).post(create_user))
        .route("/users/{id}", get(show_user).put(update_user).delete(delete_user))
        .route("/users/{id}/posts/{post_id}", get(show_post))
        .route("/sessions", post(create_session))
}

pub fn reports() -> Router<AppState> {
    Router::new().route("/{id}", get(show_report))
}

async fn index() -> &'static str {
    "api"
}

async fn list_users() -> Json<Vec<String>> {
    Json(vec![])
}

async fn create_user() -> &'static str {
    "created"
}

async fn show_user(Path(id): Path<u32>) -> String {
    id.to_string()
}

async fn update_user(Path(id): Path<u32>) -> String {
    id.to_string()
}

async fn delete_user(Path(id): Path<u32>) -> String {
    id.to_string()
}

async fn show_post(Path((id, post_id)): Path<(u32, u32)>) -> String {
    format!("{id}/{post_id}")
}

async fn create_session() -> &'static str {
    "session"
}

async fn show_user_v2(Path(id): Path<String>) -> String {
    id
}

async fn show_report(Path((version, id)): Path<(String, String)>) -> String {
    format!("{version}/{id}")
}
