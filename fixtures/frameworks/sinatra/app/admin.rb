# A modular application mounted under /admin.
require "sinatra/base"

class Admin < Sinatra::Base
  get "/" do
    "admin"
  end

  get "/reports/:id" do
    "report #{params["id"]}"
  end

  delete "/cache" do
    status 204
  end
end
