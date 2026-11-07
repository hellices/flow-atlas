defmodule AppWeb.WebhookController do
  use AppWeb, :controller

  def deliver(conn, %{"provider" => provider}), do: text(conn, "delivered from #{provider}")
  def preflight(conn, _params), do: send_resp(conn, 204, "")
end
