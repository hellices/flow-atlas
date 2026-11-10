defmodule AppWeb.Admin.ReviewController do
  use AppWeb, :controller

  def index(conn, _params), do: text(conn, "reviews")
  def new(conn, _params), do: text(conn, "new review")
  def create(conn, _params), do: send_resp(conn, 201, "created")
  def show(conn, %{"id" => id}), do: text(conn, "review #{id}")
  def edit(conn, %{"id" => id}), do: text(conn, "edit review #{id}")
  def update(conn, %{"id" => id}), do: text(conn, "updated review #{id}")
  def delete(conn, %{"id" => _id}), do: send_resp(conn, 204, "")
end
