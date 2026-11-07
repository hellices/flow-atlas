require_relative "app/classic"
require_relative "app/api"
require_relative "app/admin"

map("/api") { run Api }
map("/admin") { run Admin }
map("/") { run Sinatra::Application }
