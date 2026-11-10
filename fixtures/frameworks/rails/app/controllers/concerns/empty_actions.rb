# Each action named answers with an empty 200.
module EmptyActions
  def actions(*names)
    names.each { |name| define_method(name) { head :ok } }
  end
end
