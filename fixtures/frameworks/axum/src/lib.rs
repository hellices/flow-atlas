//! The application's routes, written as axum's routing guide shows them.
mod api;
mod teams;
mod users;

use std::convert::Infallible;

use axum::{
    Router,
    body::Body,
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{MethodFilter, any, delete, get, on, post},
};
use tower::service_fn;
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct AppState {
    pub name: &'static str,
}

pub fn app() -> Router {
    Router::new()
        .route("/", get(root))
        .route("/", post(submit))
        .route("/", delete(clear))
        .route("/assets/{*path}", get(asset))
        .route("/items/{id}", on(MethodFilter::PUT.or(MethodFilter::PATCH), replace_item))
        .route("/webhook", any(webhook))
        .route_service("/robots.txt", ServeFile::new("public/robots.txt"))
        .route_service("/ping", service_fn(|_: Request| async { Ok::<_, Infallible>(Response::new(Body::from("pong"))) }))
        .nest("/api", api::router())
        .nest("/{version}/reports", api::reports())
        .nest_service("/static", ServeDir::new("public"))
        .merge(users::router())
        .merge(teams::router())
        .fallback(not_found)
        .with_state(AppState { name: "atlas" })
}

async fn root(State(state): State<AppState>) -> String {
    format!("hello from {}", state.name)
}

async fn submit() -> StatusCode {
    StatusCode::CREATED
}

async fn clear() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn asset(Path(path): Path<String>) -> String {
    path
}

async fn replace_item(Path(id): Path<u32>) -> String {
    id.to_string()
}

async fn webhook() -> StatusCode {
    StatusCode::ACCEPTED
}

async fn not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, "nothing here")
}
