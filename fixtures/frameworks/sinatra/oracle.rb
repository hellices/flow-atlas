# Asks Sinatra which routes the application serves. config.ru is built by Rack as `rackup` builds it; each application
# its `map` blocks mount (Rack's URLMap) is walked under its location. A Sinatra application dispatches a request through
# `routes`, its class's table of [pattern, conditions, block] per verb (its superclasses' after), so that table is read:
# each route's verb, and each path its Mustermann pattern spells out, one for each optional part present or absent.
# Each path is requested through the whole application, and the route is kept only when Sinatra runs that route's own
# block for it. A splat (`*`) takes the rest of the path, and its parent where Sinatra dispatches `parent/` to it.
# Files under an application's public folder, which Sinatra serves itself before any route, are routes too: each is
# requested and kept where Sinatra answers it from that file.
ENV["APP_ENV"] = ENV["RACK_ENV"] = "production"
require "bundler/setup"
require "json"
require "rack"
require "rack/mock"

app = Rack::Builder.parse_file(File.expand_path("config.ru", __dir__))
app = app.first if app.is_a?(Array)

# Values a parameter is filled with to request a path; the first that reaches the route is kept.
SAMPLES = %w[1 a1 json].freeze

# The route whose block Sinatra ran for the last request.
$ran = nil
$instrumented = {}.compare_by_identity

def tables(klass)
  klass.ancestors.select { |k| k.is_a?(Class) && k.respond_to?(:routes) }
end

def instrument(klass)
  tables(klass).each do |k|
    k.routes.each_value do |signatures|
      signatures.each do |signature|
        next if $instrumented.key?(signature)

        $instrumented[signature] = true
        block = signature[2]
        signature[2] = proc { |a, p| $ran = signature; block.call(a, p) }
      end
    end
  end
end

def request(app, method, path)
  $ran = nil
  env = Rack::MockRequest.env_for(path, method: method)
  app.call(env)
  [$ran, env["sinatra.static_file"]]
end

# Each Sinatra application with the location Rack mounts it at.
def mounted(app, location = "")
  if app.is_a?(Rack::URLMap)
    app.instance_variable_get(:@mapping).flat_map { |_host, loc, _match, inner| mounted(inner, location + loc) }
  elsif app.is_a?(Class) && app < Sinatra::Base
    [[location, app]]
  else
    raise "config.ru runs #{app.inspect}, which is neither a Rack map nor a Sinatra application"
  end
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
version = Gem.loaded_specs["sinatra"].version.to_s
mounted(app).each do |location, klass|
  instrument(klass)
  tables(klass).each do |k|
    k.routes.each do |verb, signatures|
      signatures.each do |signature|
        pattern = signature[0]
        templates(pattern).each do |template|
          captures = template[0...(template.index(/\{\+\w+\}/) || template.size)].scan(/\{(\w+)\}/).length
          found = SAMPLES.repeated_permutation(captures).lazy.map { |values| spell(template, values) }.find do |_, path|
            request(app, verb, location + path).first.equal?(signature)
          end
          raise "#{verb} #{location}#{template} is not dispatched to the route #{pattern}" unless found

          form, _, parent = found
          raw = "#{location}#{pattern}"
          routes << { method: verb, path: canonical(location + form), raw: raw }
          if parent && request(app, verb, location + parent).first.equal?(signature)
            routes << { method: verb, path: canonical(location + form.delete_suffix("/{**}")), raw: raw }
          end
        end
      end
    end
  end

  next unless klass.static? && klass.public_folder && File.directory?(klass.public_folder)

  Dir.glob("**/*", base: klass.public_folder).sort.each do |file|
    next unless File.file?(File.join(klass.public_folder, file))

    %w[GET HEAD].each do |verb|
      path = "#{location}/#{file}"
      ran, static = request(app, verb, path)
      raise "#{verb} #{path} is not answered from #{file}" unless ran.nil? && static == File.expand_path(file, klass.public_folder)

      routes << { method: verb, path: path, raw: "#{klass.public_folder.delete_prefix("#{__dir__}/")}/#{file}" }
    end
  end
end

puts JSON.generate({ framework: "sinatra", version: version, routes: routes })
