from datetime import datetime

from starlette.convertors import Convertor


class DateTimeConvertor(Convertor):
    # The guide's convertor, with the fraction of a second its regex accepts also parsed.
    regex = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?"

    def convert(self, value: str) -> datetime:
        return datetime.fromisoformat(value)

    def to_string(self, value: datetime) -> str:
        return value.strftime("%Y-%m-%dT%H:%M:%S")
