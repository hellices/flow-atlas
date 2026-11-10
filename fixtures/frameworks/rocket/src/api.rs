use rocket::{Route, delete, get, post, routes};

/// Mounted at `/api/v1`.
pub fn routes() -> Vec<Route> {
    routes![list, create, show, remove, posts]
}

#[get("/users")]
fn list() -> &'static str {
    "users"
}

#[post("/users")]
fn create() -> &'static str {
    "created"
}

#[get("/users/<id>")]
pub fn show(id: u32) -> String {
    id.to_string()
}

#[delete("/users/<id>")]
fn remove(id: u32) -> String {
    id.to_string()
}

#[get("/users/<id>/posts/<post_id>")]
fn posts(id: u32, post_id: u32) -> String {
    format!("{id}/{post_id}")
}
