module Shop
  # Items and their reviews, mounted in each version.
  class Items < Grape::API
    resource :items do
      get do
        []
      end

      post do
        status 201
        {}
      end

      route_param :id, type: Integer do
        get do
          { id: params[:id] }
        end

        put do
          { id: params[:id] }
        end

        delete do
          status 204
          body false
        end

        resources :reviews do
          get do
            []
          end

          post do
            status 201
            {}
          end
        end
      end
    end
  end
end
