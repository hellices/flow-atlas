defmodule AppWeb.ReportController do
  use AppWeb, :controller

  def show(conn, %{"year" => year}), do: text(conn, "report #{year}")
end
