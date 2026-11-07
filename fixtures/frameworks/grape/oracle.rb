# Asks Grape which routes the application serves. `API.routes` is the table Grape compiles its router from: each
# route's method (`*` for `route :any`), its versions, and its path as the Mustermann pattern Grape matches with, the
# prefix, the version segment, the namespaces and the format suffix included. Each path the pattern spells out, one for
# each optional part present or absent and `:version` as each version the route serves (the only values Grape's router
# lets it take), is requested through the application config.ru runs, and the route is kept only when Grape's router
# dispatches that request to it (the `route_info` it hands the endpoint). A splat takes the rest of the path, and its
# parent where Grape dispatches the parent to it.
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

# Every path a Mustermann pattern spells out, from the AST Mustermann parsed it into: one for each optional part present
# or absent, `{name}` for a capture and `{+name}` for a splat. (Mustermann's own `to_templates` misspells an optional
# group nested in another.)
def spell_ast(node)
  return node.map { |n| spell_ast(n) }.inject([""]) { |acc, alts| acc.product(alts).map(&:join) } if node.is_a?(Array)

  case node.type
  when :root, :group then spell_ast(node.payload)
  when :separator, :char then [node.payload]
  when :capture then ["{#{node.name}}"]
  when :splat, :named_splat then ["{+#{node.name}}"]
  when :optional then [*spell_ast(node.payload), ""]
  when :with_look_ahead then spell_ast([node.head, *node.payload])
  when :union then node.payload.flat_map { |n| spell_ast(n) }
  else raise "unexpected #{node.type} in a route's pattern"
  end
end

def templates(pattern)
  return spell_ast(pattern.to_ast).uniq unless pattern.respond_to?(:patterns)

  pattern.patterns.map { |p| templates(p) }.inject([""]) { |acc, alts| acc.product(alts).map(&:join) }
end

def canonical(path)
  path = path.squeeze("/").chomp("/").gsub(/(?:\{\})+/, "{}")
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
  templates(route.pattern.pattern).each do |template|
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
