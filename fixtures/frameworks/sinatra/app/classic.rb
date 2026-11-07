# A classic application: routes defined at the top level, on Sinatra::Application.
require "sinatra"
require "sinatra/multi_route"

set :public_folder, File.expand_path("../public", __dir__)

get "/" do
  "home"
end

get "/hello/:name" do |name|
  "Hello #{name}!"
end

get "/posts/:format?" do
  "posts as #{params["format"] || "html"}"
end

get "/files/*" do
  params["splat"].first
end

get "/help", "/faq" do
  "help"
end

get "/flights/:from-:to" do
  "#{params["from"]} to #{params["to"]}"
end

route :get, :post, "/contact" do
  request.request_method
end

post "/items" do
  status 201
end

put "/items/:id" do
  "replaced"
end

patch "/items/:id" do
  "modified"
end

delete "/items/:id" do
  status 204
end

options "/items" do
  headers "allow" => "POST, OPTIONS"
end
