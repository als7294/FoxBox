"""The engine-wide error shape: every non-2xx response is ``{"error": {code, message, hint, retryable, model_id}}``."""
from __future__ import annotations

from fvwks_contracts.models import ApiError


class ApiException(Exception):
    def __init__(self, status: int, code: str, message: str, hint: str | None = None, retryable: bool = False,
                 model_id: str | None = None):
        super().__init__(message)
        self.status = status
        # model_id (v0.6): for model_not_installed, the model to install (the app deep-links to its card)
        self.error = ApiError(code=code, message=message, hint=hint, retryable=retryable, model_id=model_id)


class NotFound(ApiException):
    def __init__(self, what: str, ident: str):
        super().__init__(404, "not_found", f"{what} '{ident}' not found")
        self.what, self.ident = what, ident
