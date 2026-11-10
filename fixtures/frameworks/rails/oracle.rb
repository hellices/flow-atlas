# Asks Rails which routes the application serves. The router dispatches each request through
# `Rails.application.routes.routes` (the table `bin/rails routes` prints): each route's verb, and its path as the Journey
# AST Rails parsed it into, optional groups such as `(.:format)` and `(/:page)` included. Each path the AST spells out
# with or without each optional group is requested through the application, and the route is kept only when the
# router dispatches that request to it (`request.route`). A mounted engine's routes are its own router's table, under
# the mount's path; a mounted Rack application takes its path and everything below it. A glob also takes its parent
# path where the router dispatches `parent/` to it.
#
# Rails' own routes (`rails/*`, `active_storage/*`, `action_mailbox/*`) are left out: the application loads none of
# those frameworks and runs in production, where Rails adds no `rails/info` routes; should a release add one, it is
# dropped here all the same.
ENV["RAILS_ENV"] = "production"
require_relative "config/environment"
require "json"
require "rack/mock"

INTERNAL = %r{\A(?:rails|active_storage|action_mailbox)/}

# Values a parameter is filled with to request a path, the first its constraint takes.
SAMPLES = %w[1 a1 en A12345 2024 01].freeze

def sample(name, regexp)
  candidates = name == "format" ? ["json", *SAMPLES] : SAMPLES
  candidates.find { |value| value.match?(/\A(?:#{regexp})\z/) } or raise "no sample value for :#{name} (#{regexp.inspect})"
end

# Every path the AST spells out, each as [canonical form, a path to request].
def spell(node)
  case node.type
  when :CAT
    spell(node.left).product(spell(node.right)).map { |(a, b), (c, d)| [a + c, b + d] }
  when :GROUP
    [["", ""], *spell(node.left)]
  when :OR
    node.children.flat_map { |child| spell(child) }
  when :SYMBOL
    [["{}", sample(node.name, node.regexp)]]
  when :STAR
    [["{**}", "a/b"]]
  when :LITERAL, :SLASH, :DOT
    [[node.left, node.left]]
  else
    raise "unexpected #{node.type} in a route's path"
  end
end

def canonical(path)
  raise "a wildcard before the end of #{path}" if path.include?("{**}") && !path.end_with?("/{**}")

  path = path.squeeze("/").chomp("/")
  path.empty? ? "/" : path
end

def verbs(route)
  route.verb.empty? ? ["*"] : route.verb.split("|")
end

def dispatched(method, path)
  env = Rack::MockRequest.env_for(path, method: method == "*" ? "GET" : method)
  begin
    _, headers, = Rails.application.call(env)
  rescue ActionController::RoutingError => e
    # The application shows no exceptions: DebugExceptions raises the router's 404 (`x-cascade: pass`) as this error,
    # with the route last tried left in the env. The same error raised by an action is that action's route's.
    return nil if e.backtrace_locations&.first&.path&.end_with?("action_dispatch/middleware/debug_exceptions.rb")

    return env["action_dispatch.route"]
  rescue StandardError
    # An action that raises was dispatched to all the same.
    return env["action_dispatch.route"]
  end
  env["action_dispatch.route"] unless (headers["x-cascade"] || headers["X-Cascade"]) == "pass"
end

def describe(route)
  route ? "#{route.verb} #{route.path.spec}" : "no route"
end

def confirm!(route, method, path)
  got = dispatched(method, path)
  raise "#{method} #{path} is dispatched to #{describe(got)}, not #{route.path.spec}" unless got.equal?(route)
end

# Each route's paths as written out, [method, canonical form], by the route; and a path to request for each.
FORMS = Hash.new { |hash, route| hash[route] = [] }.compare_by_identity
REQUEST_PATHS = []

def record(out, route, verb, canonical_path, path, raw)
  out << { method: verb, path: canonical_path, raw: raw }
  FORMS[route] << [verb, canonical_path]
  REQUEST_PATHS << (path.squeeze("/").chomp("/").then { |p| p.empty? ? "/" : p })
end

def internal?(route)
  INTERNAL.match?(route.defaults[:controller].to_s)
end

def walk(router_routes, prefixes, raw_prefix, out)
  router_routes.each do |route|
    next if internal?(route)

    spelled = spell(route.path.spec)
    joined = prefixes.product(spelled).map { |(pc, pp), (c, p)| [pc + c, pp + p] }
    raw = "#{raw_prefix}#{route.path.spec}"
    if route.app.engine?
      walk(route.app.rack_app.routes.routes, joined, raw, out)
      next
    end
    # A mounted Rack application: the router hands it the mount's path and every path below it.
    joined = joined.flat_map { |c, p| [[c, p], ["#{c}/{**}", "#{p}/a/b"]] } unless route.path.anchored
    joined.each do |c, p|
      verbs(route).each do |verb|
        confirm!(route, verb, p)
        record(out, route, verb, canonical(c), p, raw)
        next unless c.end_with?("/{**}")

        # The parent of a glob, where the router dispatches `parent/` to the same route.
        parent = p.delete_suffix("a/b")
        record(out, route, verb, canonical(c.delete_suffix("/{**}")), parent, raw) if dispatched(verb, parent).equal?(route)
      end
    end
  end
end

routes = []
walk(Rails.application.routes.routes, [["", ""]], "", routes)

# Which of a route's paths a request took: the route is the one the router reports (`request.route`); this only picks
# the one of its written-out forms (with or without an optional group) the request's path has the shape of, a
# parameter being a segment without a `.` as Rails' default requirement for a parameter is.
def form_of(route, method, path)
  verb = verbs(route) == ["*"] ? "*" : method
  path = path.chomp("/").then { |p| p.empty? ? "/" : p }
  form = FORMS[route].find do |v, c|
    next false unless v == verb

    shape = c.split(/(\{\*\*\}|\{\})/).map { |part| { "{}" => "[^/.]+", "{**}" => ".+" }[part] || Regexp.escape(part) }.join
    /\A#{shape}\z/.match?(path)
  end
  raise "#{method} #{path} is dispatched to #{describe(route)}, none of whose paths it has the shape of" unless form

  "#{verb} #{form[1]}"
end

# Sample requests, and the route Rails dispatches each to: every route's sample path, also with a trailing `/`, and a
# path no route takes, each with every method a route registers, HEAD and OPTIONS only where a route registers them on
# their own (the compared form leaves out the HEAD beside a GET and the OPTIONS beside another method of the same path).
# Rails tries the routes in the order they are drawn and takes the first that matches the path, the verb and the
# constraints; it matches a path without its trailing `/` and redirects none. A request no route takes gets the
# router's 404 (`x-cascade: pass`) and is dispatched to none. A `redirect(...)` route answers with a redirect of its
# own, but the request is dispatched to that route, so it is recorded as such.
methods_at = Hash.new { |hash, path| hash[path] = Set.new }
routes.each { |r| methods_at[r[:path]] << r[:method] }
methods = routes.reject do |r|
  r[:method] == "*" ||
    (r[:method] == "HEAD" && methods_at[r[:path]].include?("GET")) ||
    (r[:method] == "OPTIONS" && methods_at[r[:path]].size > 1)
end.map { |r| r[:method] }.uniq.sort
samples = REQUEST_PATHS.uniq
probes = (samples + samples.map { |s| s == "/" ? s : "#{s}/" } + ["/nowhere/value1"]).uniq.sort
requests = probes.flat_map do |path|
  methods.map do |method|
    route = dispatched(method, path)
    { method: method, path: path, route: route && form_of(route, method, path) }
  end
end
puts JSON.generate({ framework: "rails", version: Rails.version, routes: routes, requests: requests })
