defmodule AppWeb.Api.V2.SignalController do
  use AppWeb, :controller

  def create(conn, _params), do: conn |> put_status(202) |> json(%{})
end
