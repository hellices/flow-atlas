defmodule AppWeb.Api.V1.OrderController do
  use AppWeb, :controller

  def index(conn, _params), do: json(conn, [])
  def create(conn, _params), do: conn |> put_status(201) |> json(%{})
  def show(conn, %{"id" => id}), do: json(conn, %{id: id})
  def update(conn, %{"id" => id}), do: json(conn, %{id: id})
  def delete(conn, %{"id" => _id}), do: send_resp(conn, 204, "")
  def invoice(conn, %{"order_id" => id}), do: json(conn, %{order: id})
  def cancel(conn, %{"id" => id}), do: json(conn, %{id: id, cancelled: true})
end
