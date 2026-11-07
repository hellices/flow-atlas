//! The application's routes, written as Rocket's guide shows them.
mod admin;
mod api;

use std::path::PathBuf;

use rocket::fs::FileServer;
use rocket::http::Method;
use rocket::route::{Handler, Outcome, Route};
use rocket::{Build, Data, Request, Rocket, catch, catchers, delete, get, head, options, patch, post, put, routes};

/// The application, as `#[launch]` builds it.
pub fn rocket() -> Rocket<Build> {
    rocket::build()
        .mount("/", routes![index, create, hello, hello_age, page, foo_bar, everything, user, user_int, user_str])
        .mount("/", routes![search, replace, remove, amend, probe, allow, custom])
        .mount("/", vec![Route::new(Method::Get, "/manual/<id>", Manual)])
        .mount("/admin", admin::routes())
        .mount("/api/v1", api::routes())
        .mount("/api/v2", routes![api::show])
        .mount("/static", FileServer::from("public"))
        .register("/", catchers![not_found])
}

#[get("/")]
fn index() -> &'static str {
    "Hello, world!"
}

#[post("/", data = "<body>")]
fn create(body: String) -> String {
    body
}

#[get("/hello/<name>")]
fn hello(name: &str) -> String {
    format!("Hello, {name}!")
}

#[get("/hello/<name>/<age>/<cool>")]
fn hello_age(name: &str, age: u8, cool: bool) -> String {
    format!("{name} {age} {cool}")
}

#[get("/page/<path..>")]
fn page(path: PathBuf) -> String {
    path.display().to_string()
}

#[get("/foo/<_>/bar")]
fn foo_bar() -> &'static str {
    "Foo _____ bar!"
}

/// Every other GET, after the file server (rank 10).
#[get("/<_..>", rank = 20)]
fn everything() -> &'static str {
    "Hey, you're here."
}

#[get("/user/<id>")]
fn user(id: usize) -> String {
    id.to_string()
}

#[get("/user/<id>", rank = 2)]
fn user_int(id: isize) -> String {
    id.to_string()
}

#[get("/user/<id>", rank = 3)]
fn user_str(id: &str) -> String {
    id.to_owned()
}

#[get("/search?<q>&<page>")]
fn search(q: &str, page: Option<usize>) -> String {
    format!("{q} {}", page.unwrap_or(1))
}

#[put("/items/<id>", data = "<body>")]
fn replace(id: u32, body: String) -> String {
    format!("{id} {body}")
}

#[delete("/items/<id>")]
fn remove(id: u32) -> String {
    id.to_string()
}

#[patch("/items/<id>")]
fn amend(id: u32) -> String {
    id.to_string()
}

#[head("/status")]
fn probe() {}

#[options("/status")]
fn allow() {}

#[rocket::route(GET, uri = "/custom/<a>/<b>")]
fn custom(a: &str, b: &str) -> String {
    format!("{a}/{b}")
}

/// A handler written as a type, mounted with `Route::new`.
#[derive(Clone)]
struct Manual;

#[rocket::async_trait]
impl Handler for Manual {
    async fn handle<'r>(&self, req: &'r Request<'_>, _data: Data<'r>) -> Outcome<'r> {
        Outcome::from(req, req.param::<&str>(0).and_then(Result::ok).unwrap_or_default().to_owned())
    }
}

#[catch(404)]
fn not_found(req: &Request<'_>) -> String {
    format!("{} is not here", req.uri())
}
