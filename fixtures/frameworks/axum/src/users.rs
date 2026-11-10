use axum::{Router, extract::Path, routing::get};

use super::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/users", get(list)).route("/users/{id}", get(show))
}

async fn list() -> &'static str {
    "users"
}

async fn show(Path(id): Path<String>) -> String {
    id
}
