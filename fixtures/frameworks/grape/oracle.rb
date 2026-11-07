# Asks Grape which routes the application serves. `API.routes` is the table Grape compiles its router from: each
# route's method (`*` for `route :any`), its version, and its path as the Mustermann pattern Grape matches with, the
# prefix, the version segment, the namespaces and the format suffix included. The pattern is spelled out as the URI
# templates Mustermann generates from it, one for each optional part present or absent, with `:version` as each version
# the route serves (the only values Grape's router lets it take). Each template is requested through the application
# config.ru runs, and the route is kept only when Grape's router dispatches that request to it (the `route_info` it
# hands the endpoint). A splat takes the rest of the path, and its parent where Grape dispatches the parent to it.
ENV["RACK_ENV"] = "production"
require "bundler/setup"
require "json"
require "rack"
require "rack/mock"

app = Rack::Builder.parse_file(File.expand_path("config.ru", __dir__))
app = app.first if app.is_a?(Array)
api = Shop::API

# Values a parameter is filled with to request a path; the first that reaches the route is kept.
SAMPLES = %w[1 a1 json 2024 01].freeze

def key(route)
  [route.request_method, route.path, Array(route.version).map(&:to_s)]
end

def dispatched(app, method, path)
  env = Rack::MockRequest.env_for(path, method: method == "*" ? "GET" : method)
  app.call(env)
  env.dig("grape.routing_args", :route_info)
end

def reaches?(app, route, method, path)
  got = dispatched(app, method, path)
  got && (got.equal?(route) || key(got) == key(route))
end

def canonical(path)
  path = path.squeeze("/").chomp("/")
  path.empty? ? "/" : path
end

# The template spelled with the parameters filled in by values: [canonical form, a path to request, the splat's parent
# to request]. A splat takes the rest of the path, whatever follows it in the template included.
def spell(template, values)
  splat = template.index(/\{\+\w+\}/)
  head = splat ? template[0...splat] : template
  index = -1
  form = head.gsub(/\{\w+\}/, "{}")
  path = head.gsub(/\{\w+\}/) { values[index += 1] }
  return [form, path] unless splat

  slash = head.end_with?("/") ? "" : "/"
  ["#{form}#{slash}{**}", "#{path}#{slash}a/b", path]
end

routes = []
all = api.routes
duplicates = all.group_by { |r| key(r) }.select { |_, list| list.size > 1 }.keys
raise "routes Grape cannot tell apart: #{duplicates.inspect}" unless duplicates.empty?

all.each do |route|
  method = route.request_method
  versions = Array(route.version).map(&:to_s)
  route.pattern.pattern.to_templates.each do |template|
    (template.include?("{version}") ? versions : [nil]).each do |version|
      text = version ? template.gsub("{version}", version) : template
      captures = text[0...(text.index(/\{\+\w+\}/) || text.size)].scan(/\{(\w+)\}/).length
      found = SAMPLES.repeated_permutation(captures).lazy.map { |values| spell(text, values) }.find do |_, path|
        reaches?(app, route, method, path)
      end
      raise "#{method} #{text} is not dispatched to the route #{route.path}" unless found

      form, _, parent = found
      routes << { method: method, path: canonical(form), raw: route.path }
      routes << { method: method, path: canonical(form.delete_suffix("/{**}")), raw: route.path } if parent && reaches?(app, route, method, parent)
    end
  end
end

puts JSON.generate({ framework: "grape", version: Grape::VERSION, routes: routes })
