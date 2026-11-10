defmodule AppWeb.PostController do
  use AppWeb, :controller

  def index(conn, params), do: text(conn, "posts of #{params["user_id"] || "everyone"}")
  def new(conn, _params), do: text(conn, "new post")
  def create(conn, _params), do: send_resp(conn, 201, "created")
  def show(conn, %{"id" => id}), do: text(conn, "post #{id}")
  def edit(conn, %{"id" => id}), do: text(conn, "edit post #{id}")
  def update(conn, %{"id" => id}), do: text(conn, "updated post #{id}")
  def delete(conn, %{"id" => _id}), do: send_resp(conn, 204, "")
end
