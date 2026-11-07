defmodule AppWeb.ArticleController do
  use AppWeb, :controller

  def index(conn, _params), do: text(conn, "articles")
  def show(conn, %{"slug" => slug}), do: text(conn, "article #{slug}")
end
