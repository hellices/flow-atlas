class PagesController < ApplicationController
  actions :home, :about, :show

  # A page taken down: the action raises the error Rails raises for a request no route takes.
  def retired
    raise ActionController::RoutingError, "Not Found"
  end
end
