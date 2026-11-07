defmodule AppWeb.PageController do
  use AppWeb, :controller

  def home(conn, _params), do: text(conn, "home")
  def about(conn, _params), do: text(conn, "about")
  def anything(conn, _params), do: text(conn, "anything: #{conn.method}")
end
