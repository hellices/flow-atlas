module Shop
  # The second version, by path: /api/v2/...
  class V2 < Grape::API
    version "v2", using: :path

    mount Items

    route %w[GET POST], "search" do
      []
    end

    get "files/*path" do
      { path: params[:path] }
    end
  end
end
