defmodule AppWeb.Api.V1.ItemController do
  use AppWeb, :controller

  def index(conn, %{"order_id" => _order_id}), do: json(conn, [])
  def create(conn, %{"order_id" => _order_id}), do: conn |> put_status(201) |> json(%{})
end
