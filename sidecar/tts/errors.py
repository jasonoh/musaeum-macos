"""One base class for every refusal the speech RPC turns into a sentence.

`synthesize_rpc` answers `{ "error": str(exc) }` for any `TtsError` and lets
everything else raise: a missing model or a missing pronunciation bundle is a normal
outcome the reader shows in one line, and a bug is not.
"""


class TtsError(Exception):
    """A refusal whose message is fit to show a person."""
