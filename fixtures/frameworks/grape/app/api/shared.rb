module Shop
  # Endpoints both versions serve the same: /api/v1/... and /api/v2/...
  class Shared < Grape::API
    version "v1", "v2", using: :path

    mount Users

    group :status do
      get do
        { status: "ok" }
      end
    end
  end
end
