// Asks Rocket which routes the application serves: `Rocket::routes()` lists the routes its router dispatches with,
// each with its method and its path as mounted. A path that ends in a segments parameter (`<path..>`, `<_..>`) is also
// requested with nothing after its last `/`, without and with that `/`, through Rocket's local client: when Rocket
// dispatches that request to the route itself (`Request::route()` once it is answered), the path before the `/` is
// written as well.
use std::sync::Mutex;

use rocket::fairing::AdHoc;
use rocket::http::Method;
use rocket::local::blocking::Client;
use rocket::{Config, Route};
use serde_json::json;

/// The route Rocket dispatched the last request to, by address in its router.
static ROUTED: Mutex<Option<usize>> = Mutex::new(None);

/// `<name>` as `{}`, `<name..>` as `{**}`, no trailing `/` but on the root.
fn canonical(segments: &[&str]) -> String {
    let path: Vec<String> = segments
        .iter()
        .map(|s| match s {
            s if s.starts_with('<') && s.ends_with("..>") => "{**}".to_owned(),
            s if s.starts_with('<') && s.ends_with('>') => "{}".to_owned(),
            s => (*s).to_owned(),
        })
        .collect();
    let path = path.join("/");
    let path = path.trim_end_matches('/');
    if path.is_empty() { "/".to_owned() } else { path.to_owned() }
}

/// The version of Rocket compiled: the one Cargo.lock names.
fn version() -> String {
    let lock = std::fs::read_to_string("Cargo.lock").expect("Cargo.lock");
    let entry = "\nname = \"rocket\"\nversion = \"";
    let at = lock.find(entry).expect("rocket in Cargo.lock") + entry.len();
    lock[at..].split('"').next().unwrap().to_owned()
}

fn main() {
    let rocket = rocket_routes::rocket()
        .configure(Config::figment().merge(("log_level", "off")))
        .attach(AdHoc::on_response("oracle", |req, _| {
            Box::pin(async move {
                *ROUTED.lock().unwrap() = req.route().map(|r| r as *const Route as usize);
            })
        }));
    let client = Client::untracked(rocket).expect("the application launches");
    let mut routes = Vec::new();
    for route in client.rocket().routes() {
        let path = route.uri.path();
        let raw = route.uri.as_str();
        let method = route.method.as_str();
        let segments: Vec<&str> = path.split('/').collect();
        routes.push(json!({ "method": method, "path": canonical(&segments), "raw": raw }));
        if !segments.last().is_some_and(|s| s.starts_with('<') && s.ends_with("..>")) {
            continue;
        }
        let parent = segments[..segments.len() - 1].join("/");
        if parent.contains('<') {
            panic!("{raw}: a parameter before the segments parameter is not requested by this oracle");
        }
        let mut dispatched = false;
        for request in [parent.clone(), format!("{parent}/")] {
            if request.is_empty() {
                continue;
            }
            *ROUTED.lock().unwrap() = None;
            client.req(route.method, request.as_str()).dispatch();
            dispatched |= *ROUTED.lock().unwrap() == Some(route as *const Route as usize);
        }
        if dispatched {
            routes.push(json!({ "method": method, "path": canonical(&segments[..segments.len() - 1]), "raw": raw }));
        }
    }
    // A method Rocket does not take for a route is not one this oracle writes.
    debug_assert!(routes.iter().all(|r| r["method"].as_str().unwrap().parse::<Method>().is_ok()));
    println!("{}", json!({ "framework": "rocket", "version": version(), "routes": routes }));
}
