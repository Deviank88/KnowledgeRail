"""Adversarial strings and indentation examples."""

RAW = r"raw def fake_raw(): # still text"
BYTES = br"bytes class FakeBytes: pass"
FORMATTED = Fr"value={format_value("quoted", {"nested": 1})}"
UNICODE = u"caffè λ"
ADJACENT = "def fake_adjacent():" "class FakeAdjacent:"


class TabIndented:
	"""A class whose suite consistently uses tabs."""

	def calculate(
		self,
		values: list[int],
	) -> int:
		return sum(
			value
			for value in values
		)


class SpaceIndented:
    # Fallback documentation for the visible method.
    def visible(self) -> str:
        payload = (
            """A multiline value containing misleading source text.
def fake_from_triple():
    return 0
class FakeFromTriple:
    pass
"""
        )
        return payload


def testimonial_view():
    return "ordinary production view"


def inline_documented(): "Inline one-line documentation."; return "documented"
