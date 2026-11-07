require "grape"
require_relative "api/items"
require_relative "api/users"
require_relative "api/v1"
require_relative "api/v2"
require_relative "api/shared"
require_relative "api/admin"

module Shop
  # The API the application serves: every version under the `api` prefix, the newest mounted first.
  class API < Grape::API
    prefix :api
    format :json

    mount V2
    mount V1
    mount Shared
    mount Admin => "/backoffice"

    get :health do
      { status: "ok" }
    end

    route :any, "*path" do
      error!({ error: "not found" }, 404)
    end
  end
end
