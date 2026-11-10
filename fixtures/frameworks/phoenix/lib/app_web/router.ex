defmodule AppWeb.Router do
  use AppWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", AppWeb do
    pipe_through :browser

    get "/", PageController, :home
    get "/about", PageController, :about

    resources "/users", UserController do
      resources "/posts", PostController
    end

    resources "/posts", PostController, only: [:index, :show]
    resources "/comments", CommentController, except: [:delete]
    resources "/account", AccountController, singleton: true
    resources "/articles", ArticleController, param: "slug", only: [:index, :show]

    get "/files/*path", FileController, :show
    get "/reports/year-:year", ReportController, :show
    match :move, "/events/:id", EventController, :move
    match :*, "/anything", PageController, :anything

    live_session :default do
      live "/counter", CounterLive
      live "/counter/:id", CounterLive, :show
    end
  end

  scope "/admin", AppWeb.Admin, as: :admin do
    pipe_through :browser

    resources "/reviews", ReviewController
    resources "/images", ImageController, only: [:index, :create, :delete]
  end

  scope "/api", AppWeb.Api do
    pipe_through :api

    scope "/v1", V1 do
      resources "/orders", OrderController, except: [:new, :edit] do
        resources "/items", ItemController, only: [:index, :create]
        get "/invoice", OrderController, :invoice
      end

      put "/orders/:id/cancel", OrderController, :cancel
    end
  end

  scope path: "/api/v2", alias: AppWeb.Api.V2, as: :v2 do
    pipe_through :api

    get "/status", StatusController, :show
    post "/signals", SignalController, :create
  end

  scope "/hooks", AppWeb do
    pipe_through :api

    post "/:provider", WebhookController, :deliver
    options "/:provider", WebhookController, :preflight
  end

  scope "/", AppWeb do
    forward "/legacy", LegacyRouter
    forward "/internal", InternalRouter
  end
end
