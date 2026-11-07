// axum, as the oracle compiles the application against it: everything is axum's own (`pub use axum_real::*`) but
// `Router` and the method routers, which forward each call to axum's and record what the application registers. Each
// handler or service is registered on axum with a layer that writes its registration's number on the response, beside
// the route axum matched (`MatchedPath`), so the oracle can tell which registration axum dispatched a request to.
pub use axum_real::*;

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};

use axum_real::extract::{MatchedPath, Request};
use axum_real::handler::Handler;
use axum_real::http::HeaderValue;
use axum_real::response::{IntoResponse, Response};
use tower::{Layer, Service};

/// What the application registered: a handler or a service, under the path it was registered at (nesting included).
#[derive(Clone, Debug)]
pub struct Registration {
    pub id: usize,
    /// The method the handler was registered for, `*` for `any`; `None` for a service, which takes every method.
    pub method: Option<String>,
    pub path: String,
    /// Registered with `nest_service`: the path is a prefix.
    pub nested: bool,
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn next_id() -> usize {
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Writes `x-route` (the registration's number) and `x-matched` (the route axum matched) on each response.
#[derive(Clone)]
pub struct Tag(usize);

impl<T> Layer<T> for Tag {
    type Service = Tagged<T>;
    fn layer(&self, inner: T) -> Tagged<T> {
        Tagged { id: self.0, inner }
    }
}

#[derive(Clone)]
pub struct Tagged<T> {
    id: usize,
    inner: T,
}

impl<T> Service<Request> for Tagged<T>
where
    T: Service<Request> + Send + 'static,
    T::Response: IntoResponse,
    T::Future: Send + 'static,
{
    type Response = Response;
    type Error = T::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Response, T::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), T::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request) -> Self::Future {
        let id = self.id;
        let matched = req.extensions().get::<MatchedPath>().map(|m| m.as_str().to_owned());
        let future = self.inner.call(req);
        Box::pin(async move {
            let mut res = future.await?.into_response();
            res.headers_mut().insert("x-route", HeaderValue::from(id));
            if let Some(matched) = matched.and_then(|m| HeaderValue::from_str(&m).ok()) {
                res.headers_mut().insert("x-matched", matched);
            }
            Ok(res)
        })
    }
}

pub mod routing {
    pub use axum_real::routing::*;

    use super::{Registration, Tag, next_id};
    use axum_real::handler::Handler;
    use axum_real::routing as real;

    /// axum's `MethodRouter`, with the handlers it holds: each one's registration and method.
    pub struct MethodRouter<S = ()> {
        pub(crate) inner: real::MethodRouter<S>,
        pub(crate) handlers: Vec<(usize, String)>,
    }

    /// The methods a `MethodFilter` takes.
    fn filter_methods(filter: MethodFilter) -> Vec<&'static str> {
        [
            (MethodFilter::GET, "GET"),
            (MethodFilter::POST, "POST"),
            (MethodFilter::PUT, "PUT"),
            (MethodFilter::DELETE, "DELETE"),
            (MethodFilter::PATCH, "PATCH"),
            (MethodFilter::HEAD, "HEAD"),
            (MethodFilter::OPTIONS, "OPTIONS"),
            (MethodFilter::TRACE, "TRACE"),
            (MethodFilter::CONNECT, "CONNECT"),
        ]
        .into_iter()
        .filter(|(f, _)| filter.or(*f) == filter)
        .map(|(_, m)| m)
        .collect()
    }

    pub fn on<H, T, S>(filter: MethodFilter, handler: H) -> MethodRouter<S>
    where
        H: Handler<T, S>,
        T: 'static,
        S: Clone + Send + Sync + 'static,
    {
        let id = next_id();
        let handlers = filter_methods(filter).into_iter().map(|m| (id, m.to_owned())).collect();
        // `route_layer` tags the handler only, not the 405 the method router answers other methods with.
        MethodRouter { inner: real::on(filter, handler).route_layer(Tag(id)), handlers }
    }

    pub fn any<H, T, S>(handler: H) -> MethodRouter<S>
    where
        H: Handler<T, S>,
        T: 'static,
        S: Clone + Send + Sync + 'static,
    {
        let id = next_id();
        // `any` is the method router's fallback, which only `layer` reaches.
        MethodRouter { inner: real::any(handler).layer(Tag(id)), handlers: vec![(id, "*".to_owned())] }
    }

    macro_rules! methods {
        ($($name:ident $filter:ident),*) => {
            $(
                pub fn $name<H, T, S>(handler: H) -> MethodRouter<S>
                where
                    H: Handler<T, S>,
                    T: 'static,
                    S: Clone + Send + Sync + 'static,
                {
                    on(MethodFilter::$filter, handler)
                }
            )*
            impl<S: Clone + Send + Sync + 'static> MethodRouter<S> {
                $(
                    pub fn $name<H, T>(self, handler: H) -> Self
                    where
                        H: Handler<T, S>,
                        T: 'static,
                    {
                        self.merge($name(handler))
                    }
                )*
            }
        };
    }

    methods!(get GET, post POST, put PUT, delete DELETE, patch PATCH, head HEAD, options OPTIONS, trace TRACE, connect CONNECT);

    impl<S: Clone + Send + Sync + 'static> MethodRouter<S> {
        pub fn on<H, T>(self, filter: MethodFilter, handler: H) -> Self
        where
            H: Handler<T, S>,
            T: 'static,
        {
            self.merge(on(filter, handler))
        }

        pub fn merge(mut self, other: MethodRouter<S>) -> Self {
            self.inner = self.inner.merge(other.inner);
            self.handlers.extend(other.handlers);
            self
        }

        pub(crate) fn registrations(&self, path: &str) -> Vec<Registration> {
            self.handlers
                .iter()
                .map(|(id, method)| Registration { id: *id, method: Some(method.clone()), path: path.to_owned(), nested: false })
                .collect()
        }
    }
}

/// axum's `Router`, with the registrations it holds.
pub struct Router<S = ()> {
    inner: axum_real::Router<S>,
    registrations: Vec<Registration>,
}

impl<S: Clone + Send + Sync + 'static> Default for Router<S> {
    fn default() -> Self {
        Self::new()
    }
}

/// The path a route registered at `path` is requested at under `prefix`.
fn under(prefix: &str, path: &str) -> String {
    format!("{}{}", prefix.trim_end_matches('/'), path)
}

impl<S: Clone + Send + Sync + 'static> Router<S> {
    pub fn new() -> Self {
        Router { inner: axum_real::Router::new(), registrations: Vec::new() }
    }

    pub fn route(mut self, path: &str, method_router: routing::MethodRouter<S>) -> Self {
        self.registrations.extend(method_router.registrations(path));
        self.inner = self.inner.route(path, method_router.inner);
        self
    }

    pub fn route_service<T>(mut self, path: &str, service: T) -> Self
    where
        T: Service<Request, Error = Infallible> + Clone + Send + Sync + 'static,
        T::Response: IntoResponse,
        T::Future: Send + 'static,
    {
        let id = next_id();
        self.registrations.push(Registration { id, method: None, path: path.to_owned(), nested: false });
        self.inner = self.inner.route_service(path, Tag(id).layer(service));
        self
    }

    pub fn nest(mut self, path: &str, router: Router<S>) -> Self {
        self.registrations.extend(router.registrations.into_iter().map(|r| Registration { path: under(path, &r.path), ..r }));
        self.inner = self.inner.nest(path, router.inner);
        self
    }

    pub fn nest_service<T>(mut self, path: &str, service: T) -> Self
    where
        T: Service<Request, Error = Infallible> + Clone + Send + Sync + 'static,
        T::Response: IntoResponse,
        T::Future: Send + 'static,
    {
        let id = next_id();
        self.registrations.push(Registration { id, method: None, path: path.to_owned(), nested: true });
        self.inner = self.inner.nest_service(path, Tag(id).layer(service));
        self
    }

    pub fn merge(mut self, other: Router<S>) -> Self {
        self.registrations.extend(other.registrations);
        self.inner = self.inner.merge(other.inner);
        self
    }

    pub fn fallback<H, T>(mut self, handler: H) -> Self
    where
        H: Handler<T, S>,
        T: 'static,
    {
        self.inner = self.inner.fallback(handler);
        self
    }

    pub fn with_state<S2>(self, state: S) -> Router<S2> {
        Router { inner: self.inner.with_state(state), registrations: self.registrations }
    }
}

impl Router {
    /// axum's router, and what the application registered on it.
    pub fn into_parts(self) -> (axum_real::Router, Vec<Registration>) {
        (self.inner, self.registrations)
    }
}
