"""Small shared helpers."""

from __future__ import annotations

import contextlib
import io
import logging

log = logging.getLogger("fvwks_voice")


@contextlib.contextmanager
def quiet():
    """mlx-audio prints load chatter and transformers warns about configs. The engine's stdout is parsed by the
    app for its READY line, so keep both out of it (they go to the debug log instead)."""
    try:
        from transformers.utils import logging as hf_logging

        level = hf_logging.get_verbosity()
        hf_logging.set_verbosity_error()
    except ImportError:  # pragma: no cover
        hf_logging, level = None, None
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            yield
    finally:
        if hf_logging is not None:
            hf_logging.set_verbosity(level)
        if buf.getvalue().strip():
            log.debug("mlx-audio: %s", buf.getvalue().strip())
