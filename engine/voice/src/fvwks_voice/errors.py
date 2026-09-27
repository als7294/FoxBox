"""Voice errors carry the engine-wide error shape: {error: {code, message, hint, model_id}}."""

from __future__ import annotations


class VoiceError(Exception):
    """A user-facing voice failure. `status` is the HTTP status the server should map it to."""

    def __init__(self, code: str, message: str, hint: str | None = None, status: int = 400, *,
                 model_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.status = status
        # model_not_installed: the model to install, so the app can open its card (v0.6, S3 P7).
        self.model_id = model_id

    def to_dict(self) -> dict:
        err = {"code": self.code, "message": self.message, "hint": self.hint}
        if self.model_id:
            err["model_id"] = self.model_id
        return {"error": err}

    def __repr__(self) -> str:
        return f"VoiceError({self.code!r}, {self.message!r})"
