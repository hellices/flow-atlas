module Shop
  # The first version, by path: /api/v1/...
  class V1 < Grape::API
    version "v1", using: :path

    mount Items

    get "archive(/:year(/:month))", requirements: { year: /\d{4}/, month: /\d{2}/ } do
      { year: params[:year], month: params[:month] }
    end
  end
end
