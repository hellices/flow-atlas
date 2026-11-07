# A plain Rack application the router mounts under a prefix.
class StatusApp
  def call(env)
    [200, { "content-type" => "text/plain" }, ["status #{env["PATH_INFO"]}"]]
  end
end
