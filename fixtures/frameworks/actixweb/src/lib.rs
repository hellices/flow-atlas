//! The application's routes, written as Actix Web's URL dispatch and application guides show them.
mod accounts;
mod api;

use actix_files::Files;
use actix_web::{HttpRequest, HttpResponse, Responder, get, guard, http::Method, route, web};

/// Everything the application registers, for `App::new().configure(routes)`.
pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/", web::get().to(index))
        .route("/", web::post().to(submit))
        .route("/user", web::post().to(submit))
        .service(web::resource("/prefix").to(index))
        .service(
            web::resource("/user/{name}")
                .name("user_detail")
                .route(web::get().to(HttpResponse::Ok))
                .route(web::put().to(HttpResponse::Ok)),
        )
        .service(web::resource("/path").route(web::route().guard(guard::Get()).to(HttpResponse::Ok)))
        .service(web::resource("/items/{id:\\d+}").route(web::route().method(Method::PATCH).to(HttpResponse::Ok)))
        .service(page)
        .service(file)
        .service(tail)
        .service(values)
        .service(ping)
        .service(web::redirect("/old", "/"))
        .service(web::scope("/api").configure(api::routes))
        .service(web::scope("/accounts").configure(accounts::routes))
        .service(Files::new("/static", "public"))
        .external_resource("youtube", "https://youtube.com/watch/{video_id}")
        .default_service(web::to(not_found));
}

async fn index() -> impl Responder {
    "Hello"
}

async fn submit() -> HttpResponse {
    HttpResponse::Created().finish()
}

#[get("/foo/{name}.html")]
async fn page(path: web::Path<String>) -> String {
    path.into_inner()
}

#[get("/files/{name}.{ext}")]
async fn file(path: web::Path<(String, String)>) -> String {
    let (name, ext) = path.into_inner();
    format!("{name}.{ext}")
}

#[get("/foo/{bar}/{tail:.*}")]
async fn tail(path: web::Path<(String, String)>) -> String {
    let (bar, tail) = path.into_inner();
    format!("{bar}/{tail}")
}

#[get("/a/{v1}/{v2}/")]
async fn values(req: HttpRequest) -> String {
    format!("{} {}", req.match_info().query("v1"), req.match_info().query("v2"))
}

#[route("/ping", method = "GET", method = "POST")]
async fn ping() -> &'static str {
    "pong"
}

async fn not_found() -> HttpResponse {
    HttpResponse::NotFound().body("nothing here")
}
