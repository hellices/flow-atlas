Rails.application.routes.draw do
  root "pages#home"

  concern :commentable do
    resources :comments, only: [:index, :create]
  end

  resources :articles, concerns: :commentable do
    member do
      post :publish
    end
    collection do
      get :search
    end
    resources :revisions, only: [:index, :show], shallow: true
  end

  resources :photos, except: [:new, :edit], constraints: { id: /[A-Z]\d{5}/ }
  resources :users, only: :show, param: :username
  resources :categories, only: [:index, :show], path: "kategorien"
  resources :tags, only: [:new, :edit], path_names: { new: "neu", edit: "bearbeiten" }
  resource :profile, only: [:show, :update]
  resource :session

  draw :admin

  scope path: "/backoffice", module: "backoffice", as: "backoffice" do
    resources :invoices, only: [:index, :show]
  end

  scope module: "storefront" do
    resources :carts, only: :show
  end

  scope "(:locale)", locale: /en|ko/ do
    resources :books, only: :index
  end

  namespace :api, defaults: { format: :json } do
    namespace :v1 do
      resources :items, only: [:index, :show]
    end
    namespace :v2 do
      resources :items, only: [:index, :show, :create]
    end
  end

  get "about", to: "pages#about"
  get "pages/:slug", to: "pages#show", as: :page
  match "search", to: "search#query", via: [:get, :post]
  match "webhooks/:source", to: "webhooks#receive", via: :all
  get "archive(/:year(/:month))", to: "archive#index", constraints: { year: /\d{4}/, month: /\d{2}/ }
  get "feed(/:page)", to: "feed#index", format: false
  get "files/*path", to: "files#show", format: false
  constraints(id: /\d+/) do
    get "orders/:id", to: "orders#show"
  end

  get "stories", to: redirect("/articles")
  get "stories/:name", to: redirect("/articles/%{name}")
  direct(:homepage) { "https://rubyonrails.org" }

  get "ping", to: ->(env) { [200, { "content-type" => "text/plain" }, ["pong"]] }
  mount StatusApp.new, at: "/status"
  mount Blog::Engine, at: "/blog"

  match "*path", to: "errors#not_found", via: :all, format: false
end
