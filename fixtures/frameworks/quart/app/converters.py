from werkzeug.routing import BaseConverter


class ListConverter(BaseConverter):
    """A comma-separated list in one segment, added to the `url_map` converters as Quart's routing guide says."""

    def to_python(self, value):
        return value.split(",")

    def to_url(self, values):
        # Bound here: a generator expression has a scope of its own, where `super()` has no instance.
        to_url = super().to_url
        return ",".join(to_url(value) for value in values)
