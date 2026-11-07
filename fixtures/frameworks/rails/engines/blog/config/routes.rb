Blog::Engine.routes.draw do
  root "articles#index"
  resources :articles, only: [:index, :show]
end
