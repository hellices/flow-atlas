# Asks Phoenix which routes the application serves. `Phoenix.Router.routes/1` is the router's route table, the one
# Phoenix compiles into the clauses it matches requests with; it is expanded as `mix phx.routes` expands it: a forward
# to a plug that lists its own routes (`formatted_routes/1`, which every Phoenix router defines) stands for the routes
# it lists, mounted under the forward's path. A forward to a plug that lists none (a `Plug.Router`) is written as what
# Phoenix dispatches to it: any method on its path and everything below it.
#
# Each route is then matched by Phoenix's own matcher (`Phoenix.Router.route_info/4`, which `call/2` dispatches with)
# on a path built from it, and must come back as that route; a `*glob` or a forward is also matched with nothing after
# its `/`, to learn whether Phoenix dispatches that path to it as well.
#
#   mix run --no-start oracle.exs
defmodule Oracle do
  @param ~r/:[a-z_][a-zA-Z0-9_]*/
  @rest ["rest", "of", "it"]
  # A method no route names, for routes that take any.
  @any "PURGE"

  def routes(router) do
    Enum.flat_map(Phoenix.Router.routes(router), fn route ->
      Code.ensure_loaded(route.plug)

      if function_exported?(route.plug, :formatted_routes, 1) do
        Enum.flat_map(route.plug.formatted_routes(route.plug_opts), &nested(router, route, &1))
      else
        direct(router, route)
      end
    end)
  end

  # A route of the router's own table.
  defp direct(router, route) do
    method = method(route.verb)
    {segments, rest?} = if Map.has_key?(route.metadata, :forward), do: {split(route.path), true}, else: shape(route.path)

    %{plug: plug, plug_opts: opts} = route

    served(method, segments, rest?, route.path, fn segs ->
      match?(%{plug: ^plug, plug_opts: ^opts}, info(router, method, segs, route.path))
    end)
  end

  # A route a forwarded Phoenix router lists: the application's router must forward the request, the forwarded router
  # must match the rest of it to that route.
  defp nested(router, forward, listed) do
    method = method(listed.verb)
    {segments, rest?} = shape(listed.path)
    prefix = split(forward.path)
    plug = forward.plug

    unless function_exported?(forward.plug, :__match_route__, 3) do
      raise "#{inspect(forward.plug)} lists routes but is no Phoenix router to match them with"
    end

    served(method, prefix ++ segments, rest?, Path.join(forward.path, listed.path), fn segs ->
      match?(%{plug: ^plug}, info(router, method, segs, forward.path)) and
        info(forward.plug, method, Enum.drop(segs, length(prefix)), listed.path) != :error
    end)
  end

  defp served(method, segments, rest?, raw, dispatched?) do
    full = sample(segments) ++ if(rest?, do: @rest, else: [])

    unless dispatched?.(full) do
      raise "Phoenix does not dispatch #{method} /#{Enum.join(full, "/")} to the route #{raw}"
    end

    route = %{method: method, path: join(canonical(segments) ++ if(rest?, do: ["{**}"], else: [])), raw: raw}

    if rest? and dispatched?.(sample(segments)) do
      [%{route | path: join(canonical(segments))}, route]
    else
      [route]
    end
  end

  # The route Phoenix matches the request to, when it is the route `pattern`.
  defp info(router, method, segments, pattern) do
    request = if method == "*", do: @any, else: method

    case Phoenix.Router.route_info(router, request, segments, "") do
      %{route: ^pattern} = info -> info
      _ -> :error
    end
  end

  defp method(verb), do: verb |> to_string() |> String.upcase()

  defp split(path), do: String.split(path, "/", trim: true)

  # A final `*name` takes the rest of the path.
  defp shape(path) do
    segments = split(path)

    case List.last(segments) do
      "*" <> _ -> {Enum.drop(segments, -1), true}
      _ -> {segments, false}
    end
  end

  # `:name` is a parameter wherever it stands in its segment (`year-:year`).
  defp canonical(segments), do: Enum.map(segments, &Regex.replace(@param, &1, "{}"))
  defp sample(segments), do: Enum.map(segments, &Regex.replace(@param, &1, "value1"))

  defp join(segments), do: "/" <> Enum.join(segments, "/")
end

Application.load(:phoenix)

IO.puts(
  Jason.encode!(%{
    framework: "phoenix",
    version: to_string(Application.spec(:phoenix, :vsn)),
    routes: Oracle.routes(AppWeb.Router)
  })
)
