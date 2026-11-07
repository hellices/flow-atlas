defmodule AppWeb.CommentController do
  use AppWeb, :controller

  def index(conn, _params), do: text(conn, "comments")
  def new(conn, _params), do: text(conn, "new comment")
  def create(conn, _params), do: send_resp(conn, 201, "created")
  def show(conn, %{"id" => id}), do: text(conn, "comment #{id}")
  def edit(conn, %{"id" => id}), do: text(conn, "edit comment #{id}")
  def update(conn, %{"id" => id}), do: text(conn, "updated comment #{id}")
end
