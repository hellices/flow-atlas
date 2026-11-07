defmodule AppWeb.EventController do
  use AppWeb, :controller

  def move(conn, %{"id" => id}), do: text(conn, "moved event #{id}")
end
