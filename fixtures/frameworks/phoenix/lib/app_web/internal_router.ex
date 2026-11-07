defmodule AppWeb.InternalRouter do
  @moduledoc "A Phoenix router of its own the application router forwards `/internal` to."
  use AppWeb, :router

  scope "/", AppWeb do
    get "/health", InternalController, :health
    get "/metrics/:name", InternalController, :metric
  end
end
