# A modular application with namespaces from sinatra-contrib, mounted under /api.
require "sinatra/base"
require "sinatra/namespace"

class Api < Sinatra::Base
  register Sinatra::Namespace

  get "/" do
    "api"
  end

  namespace "/v1" do
    get "/items" do
      "items"
    end

    get "/items/:id" do
      "item #{params["id"]}"
    end

    post "/items" do
      status 201
    end

    namespace "/users/:user_id" do
      get "/orders" do
        "orders of #{params["user_id"]}"
      end
    end
  end

  namespace "/v2" do
    get "/items/:id.?:format?" do
      "item #{params["id"]} as #{params["format"] || "json"}"
    end
  end
end
