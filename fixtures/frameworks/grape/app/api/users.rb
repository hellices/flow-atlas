module Shop
  # Users by login, and their orders under a parameter segment.
  class Users < Grape::API
    namespace :users do
      get ":login", requirements: { login: /[a-z][a-z0-9]*/ } do
        { login: params[:login] }
      end

      segment ":user_id/orders" do
        get do
          []
        end

        get ":order_id", requirements: { order_id: Integer } do
          { order: params[:order_id] }
        end
      end
    end
  end
end
