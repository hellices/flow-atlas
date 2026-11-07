defmodule AppWeb.CounterLive do
  use AppWeb, :live_view

  def mount(params, _session, socket), do: {:ok, assign(socket, count: 0, id: params["id"])}

  def handle_event("inc", _params, socket), do: {:noreply, update(socket, :count, &(&1 + 1))}

  def render(assigns) do
    ~H"""
    <button phx-click="inc">{@id} {@count}</button>
    """
  end
end
