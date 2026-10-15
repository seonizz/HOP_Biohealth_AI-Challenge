"""Deterministic Unicode text segmentation with offsets into unchanged text.

These are transparent rule-based segments, not morphology or AI inference.
Offsets count Python Unicode code points, and end offsets are exclusive.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
import unicodedata
from collections.abc import Iterator


SENTENCE_METHOD = "punctuation-newline-v1"
WORD_METHOD = "unicode-letter-number-mark-v1"
NORMALIZATION_METHOD = "NFKC-casefold-v1"


@dataclass(frozen=True)
class Span:
    text: str
    start: int
    end: int

    @property
    def normalized(self) -> str:
        return normalize_word(self.text)


def normalize_word(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def iter_sentences(text: str) -> Iterator[Span]:
    """Split at newlines and terminal punctuation followed by a boundary.

    Decimal points, punctuation without a following whitespace boundary, and
    abbreviations are not linguistically disambiguated. Whitespace surrounding
    each segment is omitted; all non-whitespace source characters are retained.
    """
    start = 0
    for match in re.finditer(r"[.!?。！？]+[\"'’”」』)]*(?=\s|$)|[\r\n]+", text):
        end = match.end()
        left, right = start, end
        while left < right and text[left].isspace():
            left += 1
        while right > left and text[right - 1].isspace():
            right -= 1
        if left < right:
            yield Span(text[left:right], left, right)
        start = end
    left, right = start, len(text)
    while left < right and text[left].isspace():
        left += 1
    while right > left and text[right - 1].isspace():
        right -= 1
    if left < right:
        yield Span(text[left:right], left, right)


def iter_words(text: str, offset: int = 0) -> Iterator[Span]:
    """Return lexical occurrences, retaining combining marks and exact spans.

    Apostrophes and hyphens are included only between word characters.
    Punctuation is not treated as a lexical word. No Korean morphological
    segmentation is claimed; Korean units are whitespace/punctuation tokens.
    """
    start: int | None = None
    for i, char in enumerate(text):
        category = unicodedata.category(char)[0]
        lexical = category in "LNM" or char == "_"
        internal = (
            char in "'’‐-" and start is not None and i + 1 < len(text)
            and (unicodedata.category(text[i + 1])[0] in "LNM" or text[i + 1] == "_")
        )
        if lexical or internal:
            if start is None:
                start = i
        elif start is not None:
            yield Span(text[start:i], offset + start, offset + i)
            start = None
    if start is not None:
        yield Span(text[start:], offset + start, offset + len(text))


def tokenize(text: str) -> list[str]:
    """Normalized lexical tokens for numeric representations."""
    return [span.normalized for span in iter_words(text)]
