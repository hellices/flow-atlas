use axum::{Router, routing::get};

use super::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/teams", get(list).post(create))
}

async fn list() -> &'static str {
    "teams"
}

async fn create() -> &'static str {
    "created"
}
