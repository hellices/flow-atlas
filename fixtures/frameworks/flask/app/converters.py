from werkzeug.routing import BaseConverter


class ListConverter(BaseConverter):
    """A comma-separated list in one segment, as Flask's API documents a custom converter (`url_map.converters`)."""

    def to_python(self, value):
        return value.split(",")

    def to_url(self, values):
        return ",".join(super().to_url(value) for value in values)
