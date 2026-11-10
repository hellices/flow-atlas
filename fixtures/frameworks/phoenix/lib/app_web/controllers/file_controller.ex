defmodule AppWeb.FileController do
  use AppWeb, :controller

  def show(conn, %{"path" => path}), do: text(conn, "file #{Enum.join(path, "/")}")
end
