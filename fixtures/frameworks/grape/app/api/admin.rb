module Shop
  # An unversioned API mounted on a path.
  class Admin < Grape::API
    namespace :reports do
      get do
        []
      end

      get ":id" do
        { id: params[:id] }
      end
    end

    delete :cache do
      status 204
      body false
    end
  end
end
