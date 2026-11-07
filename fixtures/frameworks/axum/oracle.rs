// Asks axum which routes the application serves. axum's Router keeps no list of its routes that a program can read, so
// the application's own source (src/) is compiled here against oracle/recorder.rs, which is axum itself but for a
// `Router` and method routers that forward every call to axum's and record what is registered: each handler and service
// with the path it was registered at. Each registration is then requested from axum's router (tower's `oneshot`), and
// only the registration whose own handler answers counts; the path written is the route axum reports it matched
// (`MatchedPath`), so what is written is what axum dispatches.
#[path = "src/lib.rs"]
#[allow(dead_code)]
mod app;

use axum_real::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

/// The pattern's pieces: text as `Ok(text)`, a parameter `{name}` or `{*name}` as `Err(name)`.
fn tokens(pattern: &str) -> Vec<Result<String, String>> {
    let mut out = Vec::new();
    let mut rest = pattern;
    while let Some(open) = rest.find('{') {
        if rest[open + 1..].starts_with('{') {
            panic!("{pattern} escapes a brace, which the oracle does not request");
        }
        let close = rest[open..].find('}').map(|c| open + c).unwrap_or_else(|| panic!("unclosed `{{` in {pattern}"));
        out.push(Ok(rest[..open].to_owned()));
        out.push(Err(rest[open + 1..close].to_owned()));
        rest = &rest[close + 1..];
    }
    out.push(Ok(rest.to_owned()));
    out
}

/// `{name}` as `{}`, `{*name}` (the rest of the path) as `{**}`, no trailing `/` but on the root.
fn canonical(pattern: &str) -> String {
    let path: String = tokens(pattern)
        .into_iter()
        .map(|t| match t {
            Ok(text) => text,
            Err(name) if name.starts_with('*') => "{**}".to_owned(),
            Err(_) => "{}".to_owned(),
        })
        .collect();
    let path = path.trim_end_matches('/');
    if path.is_empty() { "/".to_owned() } else { path.to_owned() }
}

/// A request path the pattern matches.
fn sample(pattern: &str) -> String {
    tokens(pattern)
        .into_iter()
        .map(|t| match t {
            Ok(text) => text,
            Err(name) if name.starts_with('*') => "rest/of/it".to_owned(),
            Err(_) => "value1".to_owned(),
        })
        .collect()
}

/// The registration whose handler answers the request, the route axum matched, and the status.
async fn answers(router: &Router, method: &Method, path: &str) -> (Option<usize>, Option<String>, StatusCode) {
    let request = Request::builder().method(method.clone()).uri(path).body(Body::empty()).unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    (header("x-route").and_then(|v| v.parse().ok()), header("x-matched"), response.status())
}

const METHODS: [Method; 8] =
    [Method::GET, Method::HEAD, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS, Method::TRACE];

/// The version of axum compiled: the one Cargo.lock names.
fn version() -> String {
    let lock = std::fs::read_to_string("Cargo.lock").expect("Cargo.lock");
    let entry = "\nname = \"axum\"\nversion = \"";
    let at = lock.find(entry).expect("axum in Cargo.lock") + entry.len();
    lock[at..].split('"').next().unwrap().to_owned()
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (router, registrations) = app::app().into_parts();
    let mut routes = Vec::new();
    for reg in &registrations {
        // The requests that reach the registration, each with the path written when it answers (none: the route axum
        // matched). A remainder is also requested with nothing after its last `/`, and a nested service at its prefix;
        // a route nested at `/` both with and without the prefix's `/`.
        let mut probes: Vec<(String, Option<String>)> = Vec::new();
        let parent = if reg.nested {
            probes.push((sample(&format!("{}/rest/of/it", reg.path.trim_end_matches('/'))), None));
            Some(reg.path.trim_end_matches('/').to_owned())
        } else {
            probes.push((sample(&reg.path), None));
            reg.path.rfind("/{*").filter(|_| reg.path.ends_with('}')).map(|at| reg.path[..at].to_owned())
        };
        if let Some(parent) = parent {
            probes.push((sample(&format!("{parent}/")), Some(canonical(&parent))));
            if !parent.is_empty() {
                probes.push((sample(&parent), Some(canonical(&parent))));
            }
        }
        if reg.path.len() > 1 && reg.path.ends_with('/') {
            probes.push((sample(reg.path.trim_end_matches('/')), None));
        }

        let mut answered = 0;
        for (request, written) in probes {
            let mut served = Vec::new();
            let mut raw = None;
            match &reg.method {
                Some(m) => {
                    // `any` takes every method: each is requested.
                    let methods = if m == "*" { METHODS.to_vec() } else { vec![m.parse::<Method>().unwrap()] };
                    let mut all = true;
                    for method in &methods {
                        let (id, matched, _) = answers(&router, method, &request).await;
                        all &= id == Some(reg.id);
                        raw = raw.or(matched);
                    }
                    if all {
                        served.push(m.clone());
                    }
                }
                None => {
                    // A service takes every method axum hands it; one it answers with 405 it does not serve.
                    for method in &METHODS {
                        let (id, matched, status) = answers(&router, method, &request).await;
                        if id == Some(reg.id) && status != StatusCode::METHOD_NOT_ALLOWED {
                            served.push(method.to_string());
                            raw = raw.or(matched);
                        }
                    }
                    if served.len() == METHODS.len() {
                        served = vec!["*".to_owned()];
                    } else if served.iter().any(|m| m == "GET") {
                        served.retain(|m| m != "HEAD");
                    }
                }
            }
            if served.is_empty() {
                continue;
            }
            // Below a nested service's prefix axum keeps the route it matched to itself (its `MatchedPath` is set only at
            // the prefix): it is the prefix with the rest of the path after it.
            let raw = match raw {
                Some(raw) => raw,
                None if reg.nested => format!("{}/{{*rest}}", reg.path.trim_end_matches('/')),
                None => panic!("axum reports no matched route for {request}"),
            };
            let path = written.unwrap_or_else(|| canonical(&raw));
            for method in served {
                routes.push(json!({ "method": method, "path": path, "raw": raw }));
            }
            answered += 1;
        }
        if answered == 0 {
            panic!("{} {} is not answered by the handler registered for it", reg.method.as_deref().unwrap_or("*"), reg.path);
        }
    }
    println!("{}", json!({ "framework": "axum", "version": version(), "routes": routes }));
}
