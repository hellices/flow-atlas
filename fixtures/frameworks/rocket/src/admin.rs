//! The admin panel, three routes at one path told apart by request guards that forward, as the guide's "Forwarding
//! Guards" shows.
use rocket::http::Status;
use rocket::request::{self, FromRequest};
use rocket::response::Redirect;
use rocket::{Request, Route, get, routes, uri};

pub fn routes() -> Vec<Route> {
    routes![admin_panel, admin_panel_user, admin_panel_redirect, login]
}

pub struct User;
pub struct AdminUser;

#[rocket::async_trait]
impl<'r> FromRequest<'r> for User {
    type Error = ();
    async fn from_request(req: &'r Request<'_>) -> request::Outcome<Self, ()> {
        match req.headers().get_one("x-user") {
            Some(_) => request::Outcome::Success(User),
            None => request::Outcome::Forward(Status::Unauthorized),
        }
    }
}

#[rocket::async_trait]
impl<'r> FromRequest<'r> for AdminUser {
    type Error = ();
    async fn from_request(req: &'r Request<'_>) -> request::Outcome<Self, ()> {
        match req.headers().get_one("x-user") {
            Some("admin") => request::Outcome::Success(AdminUser),
            _ => request::Outcome::Forward(Status::Unauthorized),
        }
    }
}

#[get("/")]
fn admin_panel(_admin: AdminUser) -> &'static str {
    "Hello, administrator. This is the admin panel!"
}

#[get("/", rank = 2)]
fn admin_panel_user(_user: User) -> &'static str {
    "Sorry, you must be an administrator to access this page."
}

#[get("/", rank = 3)]
fn admin_panel_redirect() -> Redirect {
    Redirect::to(uri!("/admin", login))
}

#[get("/login")]
fn login() -> &'static str {
    "login"
}
