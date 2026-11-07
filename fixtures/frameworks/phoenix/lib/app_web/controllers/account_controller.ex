defmodule AppWeb.AccountController do
  use AppWeb, :controller

  def new(conn, _params), do: text(conn, "new account")
  def create(conn, _params), do: send_resp(conn, 201, "created")
  def show(conn, _params), do: text(conn, "account")
  def edit(conn, _params), do: text(conn, "edit account")
  def update(conn, _params), do: text(conn, "updated account")
  def delete(conn, _params), do: send_resp(conn, 204, "")
end
