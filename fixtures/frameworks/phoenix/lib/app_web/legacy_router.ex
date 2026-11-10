defmodule AppWeb.LegacyRouter do
  @moduledoc "A plain Plug.Router the Phoenix router forwards `/legacy` to."
  use Plug.Router

  plug :match
  plug :dispatch

  get "/hello" do
    send_resp(conn, 200, "hello")
  end

  post "/echo/:word" do
    send_resp(conn, 200, word)
  end

  match _ do
    send_resp(conn, 404, "not found")
  end
end
