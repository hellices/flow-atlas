defmodule AppWeb.InternalController do
  use AppWeb, :controller

  def health(conn, _params), do: text(conn, "ok")
  def metric(conn, %{"name" => name}), do: text(conn, "metric #{name}")
end
