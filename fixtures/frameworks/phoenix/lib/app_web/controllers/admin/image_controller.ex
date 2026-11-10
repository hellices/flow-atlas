defmodule AppWeb.Admin.ImageController do
  use AppWeb, :controller

  def index(conn, _params), do: text(conn, "images")
  def create(conn, _params), do: send_resp(conn, 201, "created")
  def delete(conn, %{"id" => _id}), do: send_resp(conn, 204, "")
end
