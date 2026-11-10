require "bundler/setup"
require "rails"
require "action_controller/railtie"
require_relative "../lib/status_app"
require_relative "../engines/blog/lib/blog/engine"

module Sample
  class Application < Rails::Application
    config.load_defaults 8.1
    # API and HTML: `resources` draws the `new` and `edit` forms too; Api:: controllers are ActionController::API.
    config.api_only = false
    config.action_controller.allow_forgery_protection = false
    config.eager_load = true
    config.secret_key_base = "fixture-only"
    config.logger = ActiveSupport::Logger.new(nil)
    config.action_dispatch.show_exceptions = :none
  end
end
