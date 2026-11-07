// Asks Actix Web which routes the application serves. Actix keeps the resources an application registers in a
// `ResourceMap`, the tree it answers `HttpRequest::match_pattern` and `url_for` from, scopes as its inner nodes; it
// offers no way to walk it but its `Debug` form, which this oracle reads. Each resource in it is then requested with
// every method through the application (`test::init_service`), and a method counts only when actix dispatches the
// request to one of the resource's routes: the route it matched (`HttpRequest::match_pattern`) is the resource's, and
// neither the application's default service nor actix's 405 (a resource none of whose routes takes the method)
// answered. The application's own handlers answer no 405. A parameter is written `{**}` when actix's matcher
// (`ResourceDef::is_match`) takes a value with `/` in it there, and the path before its `/` is written as well when
// actix dispatches it with nothing there.
use std::sync::Mutex;

use actix_web::body::MessageBody;
use actix_web::dev::{Path, ResourceDef, ServiceRequest, ServiceResponse};
use actix_web::http::{Method, StatusCode};
use actix_web::middleware::Next;
use actix_web::{App, HttpRequest, HttpResponse, middleware, test, web};
use serde_json::json;

/// A value in Rust's `Debug` form.
#[derive(Debug)]
enum Value {
    Str(String),
    Atom(String),
    /// `Name { .. }` or `Name(..)`: the name, then what follows it.
    Named(String, Box<Value>),
    Struct(Vec<(String, Value)>),
    Seq(Vec<Value>),
    /// A map, read past: the resource map's `named` resources, which its nodes hold as well.
    Map,
}

impl Value {
    fn field(&self, name: &str) -> &Value {
        match self {
            Value::Named(_, inner) => inner.field(name),
            Value::Struct(fields) => &fields.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("no field {name}")).1,
            _ => panic!("no field {name} in {self:?}"),
        }
    }
}

struct Parser<'a> {
    text: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn skip(&mut self) {
        while self.at < self.text.len() && self.text[self.at].is_ascii_whitespace() {
            self.at += 1;
        }
    }

    fn peek(&mut self) -> u8 {
        self.skip();
        *self.text.get(self.at).unwrap_or(&0)
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == c {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, c: u8) {
        assert!(self.eat(c), "expected `{}` at {} of the resource map", c as char, self.at);
    }

    fn word(&mut self) -> String {
        self.skip();
        let start = self.at;
        while self.at < self.text.len() && !b" ,:{}()[]\"".contains(&self.text[self.at]) {
            self.at += 1;
        }
        String::from_utf8(self.text[start..self.at].to_vec()).unwrap()
    }

    fn string(&mut self) -> String {
        self.expect(b'"');
        let mut out = String::new();
        let rest = std::str::from_utf8(&self.text[self.at..]).unwrap();
        let mut chars = rest.char_indices();
        while let Some((i, c)) = chars.next() {
            match c {
                '"' => {
                    self.at += i + 1;
                    return out;
                }
                '\\' => match chars.next().unwrap().1 {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    '0' => out.push('\0'),
                    'u' => {
                        let hex: String = chars.by_ref().map(|(_, c)| c).skip(1).take_while(|c| *c != '}').collect();
                        out.push(char::from_u32(u32::from_str_radix(&hex, 16).unwrap()).unwrap());
                    }
                    other => out.push(other),
                },
                c => out.push(c),
            }
        }
        panic!("unterminated string in the resource map")
    }

    fn list(&mut self, close: u8) -> Vec<Value> {
        let mut items = Vec::new();
        while !self.eat(close) {
            items.push(self.value());
            self.eat(b',');
        }
        items
    }

    fn value(&mut self) -> Value {
        match self.peek() {
            b'"' => Value::Str(self.string()),
            b'[' => {
                self.at += 1;
                Value::Seq(self.list(b']'))
            }
            b'(' => {
                self.at += 1;
                Value::Seq(self.list(b')'))
            }
            b'{' => {
                self.at += 1;
                // A struct's fields are names; a map's keys are values (here strings).
                if self.peek() == b'"' || self.peek() == b'}' {
                    while !self.eat(b'}') {
                        self.value();
                        self.expect(b':');
                        self.value();
                        self.eat(b',');
                    }
                    Value::Map
                } else {
                    let mut fields = Vec::new();
                    while !self.eat(b'}') {
                        let name = self.word();
                        self.expect(b':');
                        fields.push((name, self.value()));
                        self.eat(b',');
                    }
                    Value::Struct(fields)
                }
            }
            _ => {
                let word = self.word();
                assert!(!word.is_empty(), "unexpected `{}` at {} of the resource map", self.peek() as char, self.at);
                match self.peek() {
                    b'{' | b'(' => Value::Named(word, Box::new(self.value())),
                    _ => Value::Atom(word),
                }
            }
        }
    }
}

/// A resource the application registered: its full pattern (its scopes' before its own, as `match_pattern` joins them)
/// and whether it is a prefix (a service that takes every path below it).
struct Resource {
    pattern: String,
    prefix: bool,
}

/// The edge nodes of the resource map: resources and services. Named resources are also kept apart (`named`), which is
/// not walked.
fn resources(node: &Value, base: &str, out: &mut Vec<Resource>) {
    let def = node.field("pattern");
    let pattern = match def.field("patterns") {
        Value::Named(kind, inner) if kind == "Single" => match &**inner {
            Value::Seq(items) => match &items[..] {
                [Value::Str(p)] => p.clone(),
                _ => panic!("unexpected pattern {inner:?}"),
            },
            _ => panic!("unexpected pattern {inner:?}"),
        },
        other => panic!("a resource with several patterns ({other:?}) is not requested by this oracle"),
    };
    let pattern = format!("{base}{pattern}");
    match node.field("nodes") {
        Value::Named(some, inner) if some == "Some" => match &**inner {
            Value::Seq(items) => match &items[..] {
                [Value::Seq(children)] => children.iter().for_each(|child| resources(child, &pattern, out)),
                _ => panic!("unexpected nodes {inner:?}"),
            },
            _ => panic!("unexpected nodes {inner:?}"),
        },
        Value::Atom(none) if none == "None" => {
            let prefix = matches!(def.field("is_prefix"), Value::Atom(b) if b == "true");
            out.push(Resource { pattern, prefix });
        }
        other => panic!("unexpected nodes {other:?}"),
    }
}

/// The pattern's pieces: text as `Ok(text)`, a dynamic segment `{name}` or `{name:regex}` as `Err(source)`.
fn tokens(pattern: &str) -> Vec<Result<String, String>> {
    let mut out = Vec::new();
    let mut text = String::new();
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        if c != '{' {
            text.push(c);
            continue;
        }
        out.push(Ok(std::mem::take(&mut text)));
        let (mut depth, mut source) = (1, String::from("{"));
        for c in chars.by_ref() {
            source.push(c);
            depth += match c {
                '{' => 1,
                '}' => -1,
                _ => 0,
            };
            if depth == 0 {
                break;
            }
        }
        out.push(Err(source));
    }
    out.push(Ok(text));
    out
}

/// The pattern with each dynamic segment given the value at its index.
fn fill(tokens: &[Result<String, String>], values: &[&str]) -> String {
    let mut i = 0;
    tokens
        .iter()
        .map(|t| match t {
            Ok(text) => text.clone(),
            Err(_) => {
                i += 1;
                values[i - 1].to_owned()
            }
        })
        .collect()
}

const VALUES: [&str; 3] = ["value1", "1", "a"];
const REST: &str = "rest/of/it";

/// Values for the dynamic segments that actix's matcher takes, the first found trying each of `VALUES` in each.
fn sample(def: &ResourceDef, tokens: &[Result<String, String>]) -> Vec<&'static str> {
    let count = tokens.iter().filter(|t| t.is_err()).count();
    let mut index = vec![0; count];
    loop {
        let values: Vec<&str> = index.iter().map(|&i| VALUES[i]).collect();
        if def.is_match(&fill(tokens, &values)) {
            return values;
        }
        let mut k = 0;
        while k < count && index[k] == VALUES.len() - 1 {
            index[k] = 0;
            k += 1;
        }
        assert!(k < count, "no value of {VALUES:?} matches {:?}", def.pattern());
        index[k] += 1;
    }
}

/// No trailing `/` but on the root.
fn trimmed(path: &str) -> String {
    let path = path.trim_end_matches('/');
    if path.is_empty() { "/".to_owned() } else { path.to_owned() }
}

const METHODS: [Method; 8] =
    [Method::GET, Method::HEAD, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS, Method::TRACE];

/// What the probe middleware saw of the last response: the route actix matched and the resource map.
static SEEN: Mutex<(Option<String>, Option<String>)> = Mutex::new((None, None));

/// Records the route actix matched for each request, and the resource map once.
async fn probe(req: ServiceRequest, next: Next<impl MessageBody>) -> Result<ServiceResponse<impl MessageBody>, actix_web::Error> {
    let res = next.call(req).await?;
    let mut seen = SEEN.lock().unwrap();
    seen.0 = res.request().match_pattern();
    if seen.1.is_none() {
        seen.1 = Some(format!("{:?}", res.request().resource_map()));
    }
    Ok(res)
}

/// The version of Actix Web compiled: the one Cargo.lock names.
fn version() -> String {
    let lock = std::fs::read_to_string("Cargo.lock").expect("Cargo.lock");
    let entry = "\nname = \"actix-web\"\nversion = \"";
    let at = lock.find(entry).expect("actix-web in Cargo.lock") + entry.len();
    lock[at..].split('"').next().unwrap().to_owned()
}

#[actix_web::main]
async fn main() {
    // The application's default service is replaced by one the oracle tells apart: what it answers no route serves.
    let app = test::init_service(
        App::new()
            .wrap(middleware::from_fn(probe))
            .configure(actixweb_routes::routes)
            .default_service(web::to(|req: HttpRequest| async move {
                // What is left of the path: shorter than the path when a prefix service (`Files`) hands it on.
                let rest = req.match_info().unprocessed().to_owned();
                HttpResponse::NotFound().insert_header(("x-oracle-default", rest)).finish()
            })),
    )
    .await;
    // The methods actix dispatches `path` with to a route of the resource at `pattern`. A prefix service hands a path
    // it does not serve to the default service: that is still the service's answer when the default is left the path
    // after the service's prefix.
    let served = |path: String, pattern: String, prefix: bool| {
        let app = &app;
        async move {
            let mut methods = Vec::new();
            for method in METHODS {
                let req = test::TestRequest::default().method(method.clone()).uri(&path).to_request();
                let res = test::call_service(app, req).await;
                let matched = SEEN.lock().unwrap().0.take();
                let default = match res.headers().get("x-oracle-default").map(|v| v.to_str().unwrap()) {
                    None => false,
                    Some(rest) => !(prefix && path.len() - rest.len() == pattern.trim_end_matches('/').len()),
                };
                if !default && res.status() != StatusCode::METHOD_NOT_ALLOWED && matched.as_deref() == Some(&pattern) {
                    methods.push(method.to_string());
                }
            }
            if methods.len() == METHODS.len() {
                methods = vec!["*".to_owned()];
            } else if methods.iter().any(|m| m == "GET") {
                methods.retain(|m| m != "HEAD");
            }
            methods
        }
    };

    test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await;
    let map = SEEN.lock().unwrap().1.take().expect("the resource map");
    let mut parser = Parser { text: map.as_bytes(), at: 0 };
    let tree = parser.value();
    let mut found = Vec::new();
    resources(&tree, "", &mut found);

    let mut routes = Vec::new();
    for resource in &found {
        let raw = &resource.pattern;
        // The paths requested, each with the path written when actix dispatches it to the resource.
        let mut probes: Vec<(String, String)> = Vec::new();
        if resource.prefix {
            let base = trimmed(raw);
            probes.push((raw.clone(), base.clone()));
            probes.push((format!("{}/", raw.trim_end_matches('/')), base.clone()));
            probes.push((format!("{}/value1/{REST}", raw.trim_end_matches('/')), format!("{}/{{**}}", base.trim_end_matches('/'))));
        } else {
            let tokens = tokens(raw);
            let def = ResourceDef::new(raw.as_str());
            let values = sample(&def, &tokens);
            // A dynamic segment actix's matcher captures a value with `/` in is the rest of the path.
            let names: Vec<&str> = tokens
                .iter()
                .filter_map(|t| t.as_ref().err())
                .map(|source| source[1..source.len() - 1].split(':').next().unwrap())
                .collect();
            let spans: Vec<bool> = (0..values.len())
                .map(|i| {
                    let mut v = values.clone();
                    v[i] = REST;
                    let mut path = Path::new(fill(&tokens, &v));
                    def.capture_match_info(&mut path) && path.get(names[i]) == Some(REST)
                })
                .collect();
            let mut i = 0;
            let canonical: String = tokens
                .iter()
                .map(|t| match t {
                    Ok(text) => text.clone(),
                    Err(_) => {
                        i += 1;
                        if spans[i - 1] { "{**}" } else { "{}" }.to_owned()
                    }
                })
                .collect();
            let mut rest = values.clone();
            spans.iter().enumerate().filter(|(_, s)| **s).for_each(|(i, _)| rest[i] = REST);
            probes.push((fill(&tokens, &rest), trimmed(&canonical)));
            // The rest of the path, last, with nothing in it: the path before its `/`.
            if let (Some(true), [.., Ok(before), Err(_), Ok(after)]) = (spans.last(), &tokens[..]) {
                if before.ends_with('/') && after.is_empty() {
                    let mut empty = values.clone();
                    *empty.last_mut().unwrap() = "";
                    probes.push((fill(&tokens, &empty), trimmed(canonical.strip_suffix("{**}").unwrap())));
                }
            }
        }
        let mut answered = false;
        for (path, written) in probes {
            for method in served(path, raw.clone(), resource.prefix).await {
                routes.push(json!({ "method": method, "path": written, "raw": raw }));
                answered = true;
            }
        }
        assert!(answered, "actix dispatches no request to the resource {raw}");
    }
    println!("{}", json!({ "framework": "actix-web", "version": version(), "routes": routes }));
}
