defmodule AppWeb.UserController do
  use AppWeb, :controller

  def index(conn, _params), do: text(conn, "users")
  def new(conn, _params), do: text(conn, "new user")
  def create(conn, _params), do: send_resp(conn, 201, "created")
  def show(conn, %{"id" => id}), do: text(conn, "user #{id}")
  def edit(conn, %{"id" => id}), do: text(conn, "edit user #{id}")
  def update(conn, %{"id" => id}), do: text(conn, "updated user #{id}")
  def delete(conn, %{"id" => _id}), do: send_resp(conn, 204, "")
end
