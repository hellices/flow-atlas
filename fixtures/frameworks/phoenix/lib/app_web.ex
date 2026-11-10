defmodule AppWeb do
  @moduledoc """
  The entrypoint for the web interface: `use AppWeb, :router`, `use AppWeb, :controller`, `use AppWeb, :live_view`.
  """

  def router do
    quote do
      use Phoenix.Router, helpers: false

      import Plug.Conn
      import Phoenix.Controller
      import Phoenix.LiveView.Router
    end
  end

  def controller do
    quote do
      use Phoenix.Controller, formats: [:html, :json]

      import Plug.Conn
    end
  end

  def live_view do
    quote do
      use Phoenix.LiveView
    end
  end

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
