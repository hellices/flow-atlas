namespace :admin do
  resources :reports, only: :index
  get "dashboard", to: "dashboard#show"
end
