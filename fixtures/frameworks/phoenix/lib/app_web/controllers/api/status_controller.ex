defmodule AppWeb.Api.V2.StatusController do
  use AppWeb, :controller

  def show(conn, _params), do: json(conn, %{status: "ok"})
end
