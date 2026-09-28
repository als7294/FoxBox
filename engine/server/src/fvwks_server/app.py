"""FastAPI app (owned by S3).

Route signatures and models are the HTTP contract, exported to contracts/openapi.yaml by scripts/export_openapi.py,
and the drift test in engine/contracts/tests keeps them frozen. The bodies delegate to ``EngineService``.

Exposure: the engine binds 127.0.0.1 only (main.py). Every route needs ``Authorization: Bearer <token>``; only
``GET /api/audio/*`` also accepts ``?token=`` (for media elements). CORS is off unless ``--allow-origin`` is given
(dev only; the app proxies through Electron main). The engine never accepts client file paths, apart from the export
folder in Settings, which is validated.
"""

from __future__ import annotations

import hmac
import logging
from contextlib import asynccontextmanager
from typing import Literal
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, FastAPI, File, Form, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from fvwks_contracts.models import (
    ApiError,
    BatchRequest,
    ErrorEnvelope,
    ExportRequest,
    ExportResult,
    Health,
    Job,
    Lexicon,
    LibraryPage,
    MixInfo,
    MixRequest,
    ModelInfo,
    PersonaCandidate,
    PersonaDesignRequest,
    PersonaSaveRequest,
    Preset,
    RackDescriptor,
    RekordboxRequest,
    RekordboxResult,
    RenderInfo,
    RenderRequest,
    ScriptPreview,
    ScriptPreviewRequest,
    Settings,
    SignedModelManifest,
    Song,
    StemFeatures,
    SongUpdate,
    SourceInfo,
    SourceList,
    TTSRequest,
    Take,
    TakePatch,
    TranscriptUpdate,
    Voice,
)

from .config import VERSION, Config
from .errors import ApiException, NotFound
from .service import MAX_SONG_BYTES, MAX_UPLOAD_BYTES, EngineService

log = logging.getLogger("fvwks.engine")

ERRORS = {s: {"model": ErrorEnvelope} for s in (400, 401, 404, 409, 422, 500)}
_HTTP_CODES = {401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed",
               413: "file_too_large"}

__all__ = ["ApiException", "NotFound", "create_app"]


class TokenGate:
    """ASGI middleware: check the bearer token before the request body is read.

    A route dependency would only run after FastAPI parsed (JSON) or spooled (multipart) the body, so an
    unauthenticated caller could make the engine buffer arbitrarily large payloads. ``?token=`` is accepted only on
    ``GET /api/audio/*`` (media elements can't send headers).
    """

    def __init__(self, app, token: str):
        self.app = app
        self.header = f"Bearer {token}".encode()
        self.token = token.encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and not self._allowed(scope):
            body = ErrorEnvelope(error=ApiError(code="unauthorized", message="Missing or invalid engine token."))
            await JSONResponse(status_code=401, content=body.model_dump())(scope, receive, send)
            return
        await self.app(scope, receive, send)

    def _allowed(self, scope) -> bool:
        for name, value in scope.get("headers", ()):
            if name == b"authorization" and hmac.compare_digest(value, self.header):
                return True
        if scope.get("method") == "GET" and scope.get("path", "").startswith("/api/audio/"):
            query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
            return any(hmac.compare_digest(t.encode(), self.token) for t in query.get("token", []))
        return False


def create_app(config: Config) -> FastAPI:
    service = EngineService(config)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        service.close()

    # No /docs, /redoc or /openapi.json: the contract lives in contracts/openapi.yaml (app.openapi() still works).
    app = FastAPI(title="FoxBox Engine", version=VERSION, separate_input_output_schemas=False,
                  lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.service = service
    if config.token:
        app.add_middleware(TokenGate, token=config.token)  # added before CORS, so CORS preflights stay outermost
    if config.allow_origins:
        app.add_middleware(CORSMiddleware, allow_origins=config.allow_origins, allow_methods=["*"], allow_headers=["*"])

    def env(status: int, err: ApiError) -> JSONResponse:
        return JSONResponse(status_code=status, content=ErrorEnvelope(error=err).model_dump())

    @app.exception_handler(ApiException)
    async def _api_exc(_: Request, exc: ApiException):
        return env(exc.status, exc.error)

    @app.exception_handler(RequestValidationError)
    async def _val(_: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(p) for p in first.get("loc", []))
        return env(422, ApiError(code="invalid_request", message=f"{loc}: {first.get('msg', 'invalid request')}"))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException):
        return env(exc.status_code, ApiError(code=_HTTP_CODES.get(exc.status_code, "http_error"),
                                             message=str(exc.detail)))

    @app.exception_handler(Exception)
    async def _crash(_: Request, exc: Exception):
        log.exception("unhandled engine error")
        return env(500, ApiError(code="internal_error", message=f"Engine error: {type(exc).__name__}: {exc}",
                                 hint="Check the engine log.", retryable=True))

    def auth(request: Request, token: str | None = Query(default=None, include_in_schema=False)) -> None:
        if not config.token:
            return
        header = request.headers.get("authorization", "")
        if hmac.compare_digest(header.encode(), f"Bearer {config.token}".encode()):
            return
        if (token is not None and request.method == "GET" and request.url.path.startswith("/api/audio/")
                and hmac.compare_digest(token.encode(), config.token.encode())):
            return
        raise ApiException(401, "unauthorized", "Missing or invalid engine token.")

    r = APIRouter(prefix="/api", dependencies=[Depends(auth)], responses=ERRORS)

    # ------------------------------------------------------------------ system
    @r.get("/health", response_model=Health, tags=["system"], operation_id="getHealth")
    def get_health() -> Health:
        return service.health()

    @r.get("/rack", response_model=RackDescriptor, tags=["system"], operation_id="getRack")
    def get_rack() -> RackDescriptor:
        return service.rack()

    @r.get("/models", response_model=list[ModelInfo], tags=["system"], operation_id="listModels")
    def list_models() -> list[ModelInfo]:
        return service.list_models()

    @r.post("/models/{model_id}/install", response_model=Job, tags=["system"], operation_id="installModel")
    def install_model(model_id: str) -> Job:
        return service.install_model(model_id)

    @r.delete("/models/{model_id}", response_model=ModelInfo, tags=["system"], operation_id="uninstallModel")
    def uninstall_model(model_id: str) -> ModelInfo:
        """v0.6 (S3 P8): free disk. 409 model_required / model_busy. S3 implements."""
        fn = getattr(service, "uninstall_model", None)
        if fn is None:
            raise ApiException(501, "not_implemented", "Removing models arrives with the v0.6 server work.")
        return fn(model_id)

    @r.put("/models/manifest", response_model=list[ModelInfo], tags=["system"], operation_id="applyModelManifest")
    def apply_model_manifest(body: SignedModelManifest) -> list[ModelInfo]:
        """v0.6 (S3 P9): signed model-update manifest from the app's updater. S3 implements."""
        fn = getattr(service, "apply_model_manifest", None)
        if fn is None:
            raise ApiException(501, "not_implemented", "Model updates arrive with the v0.6 server work.")
        return fn(body)

    @r.get("/jobs/{job_id}", response_model=Job, tags=["system"], operation_id="getJob")
    def get_job(job_id: str) -> Job:
        return service.job(job_id)

    @r.post("/jobs/{job_id}/cancel", response_model=Job, tags=["system"], operation_id="cancelJob")
    def cancel_job(job_id: str) -> Job:
        return service.cancel_job(job_id)

    # ------------------------------------------------------------------ voices & sources
    @r.get("/voices", response_model=list[Voice], tags=["voices"], operation_id="listVoices")
    def list_voices() -> list[Voice]:
        return service.list_voices()

    @r.post("/sources/tts", response_model=SourceInfo, tags=["sources"], operation_id="createTtsSource")
    def create_tts_source(req: TTSRequest) -> SourceInfo:
        return service.create_tts(req)

    @r.post("/sources/upload", response_model=SourceInfo, tags=["sources"], operation_id="uploadSource")
    async def upload_source(file: UploadFile = File(...), kind: Literal["recording", "import"] = Form("import"),
                            name: str | None = Form(None),
                            denoise: float | None = Form(None, ge=0, le=1)) -> SourceInfo:  # v0.3
        if file.size is not None and file.size > MAX_UPLOAD_BYTES:  # refuse before reading it into memory
            raise ApiException(400, "file_too_large", f"Uploads are limited to {MAX_UPLOAD_BYTES >> 20} MB.",
                               hint="Trim the recording first.")
        data = await file.read()
        return await run_in_threadpool(service.upload, data, file.filename, kind, name, denoise)

    @r.put("/sources/{source_id}/transcript", response_model=SourceInfo, tags=["sources"],
           operation_id="updateTranscript")
    def update_transcript(source_id: str, body: TranscriptUpdate) -> SourceInfo:
        """v0.3: edit a recording's transcript (markup allowed) → re-segment + re-align."""
        return service.update_transcript(source_id, body.script)

    @r.get("/sources", response_model=SourceList, tags=["sources"], operation_id="listSources")
    def list_sources(kind: Literal["tts", "recording", "import"] | None = None, limit: int = 50, offset: int = 0) -> SourceList:
        return service.list_sources(kind, limit, offset)

    @r.get("/sources/{source_id}", response_model=SourceInfo, tags=["sources"], operation_id="getSource")
    def get_source(source_id: str) -> SourceInfo:
        return service.get_source(source_id)

    @r.delete("/sources/{source_id}", status_code=204, response_class=Response, tags=["sources"], operation_id="deleteSource")
    def delete_source(source_id: str) -> Response:
        service.delete_source(source_id)
        return Response(status_code=204)

    # ------------------------------------------------------------------ songs (v0.7)
    def _songs(name: str):
        fn = getattr(service, name, None)
        if fn is None:
            raise ApiException(501, "not_implemented", "Songs arrive with the v0.7 server work.")
        return fn

    @r.post("/songs", response_model=Song, tags=["songs"], operation_id="uploadSong")
    async def upload_song(file: UploadFile = File(...), name: str | None = Form(None)) -> Song:
        """v0.7: import a track (WAV/AIFF/FLAC/MP3; the app decodes other formats to WAV first). Analysis runs in
        the background (analysis_state); poll GET /songs/{id}."""
        fn = _songs("upload_song")
        if file.size is not None and file.size > MAX_SONG_BYTES:  # refuse before reading it into memory
            raise ApiException(400, "file_too_large", f"Songs are limited to {MAX_SONG_BYTES >> 20} MB.",
                               hint="Use an MP3 or FLAC of it, or trim it.")
        data = await file.read()
        return await run_in_threadpool(fn, data, file.filename, name)

    @r.get("/songs", response_model=list[Song], tags=["songs"], operation_id="listSongs")
    def list_songs() -> list[Song]:
        return _songs("list_songs")()

    @r.get("/songs/{song_id}", response_model=Song, tags=["songs"], operation_id="getSong")
    def get_song(song_id: str) -> Song:
        return _songs("get_song")(song_id)

    @r.patch("/songs/{song_id}", response_model=Song, tags=["songs"], operation_id="updateSong")
    def update_song(song_id: str, body: SongUpdate) -> Song:
        """Only the fields present in the body change; an explicit null clears an override."""
        return _songs("update_song")(song_id, body)

    @r.delete("/songs/{song_id}", status_code=204, response_class=Response, tags=["songs"], operation_id="deleteSong")
    def delete_song(song_id: str) -> Response:
        _songs("delete_song")(song_id)
        return Response(status_code=204)

    @r.post("/songs/{song_id}/stems", response_model=Job, tags=["songs"], operation_id="separateSongStems")
    def separate_song_stems(song_id: str) -> Job:
        """v0.9: split the song into drums, bass, vocals and other (a song_stems job; instant when cached)."""
        return _songs("request_stems")(song_id)

    @r.get("/songs/{song_id}/stems/features", response_model=StemFeatures, tags=["songs"], operation_id="getStemFeatures")
    def get_stem_features(song_id: str) -> StemFeatures:
        """v0.9: per-stem envelopes and onsets for the visuals (60 fps over the whole song)."""
        return _songs("stem_features")(song_id)

    @r.post("/mix", response_model=MixInfo, tags=["songs"], operation_id="mixSong")
    def mix_song(req: MixRequest) -> MixInfo:
        """v0.7: a song + drop mix (backing-track preview, camera-clip soundtrack)."""
        return _songs("mix_song")(req)

    @r.post("/personas/design", response_model=Job, tags=["voices"], operation_id="designPersona")
    def design_persona(req: PersonaDesignRequest) -> Job:
        return service.design_persona(req)

    @r.post("/personas", response_model=Voice, tags=["voices"], operation_id="savePersona")
    def save_persona(req: PersonaSaveRequest) -> Voice:
        return service.save_persona(req)

    @r.get("/personas/candidates/{candidate_id}", response_model=PersonaCandidate, tags=["voices"],
           operation_id="getPersonaCandidate")
    def get_persona_candidate(candidate_id: str) -> PersonaCandidate:
        return service.get_persona_candidate(candidate_id)

    @r.post("/script/preview", response_model=ScriptPreview, tags=["sources"], operation_id="previewScript")
    def preview_script(req: ScriptPreviewRequest) -> ScriptPreview:
        return service.preview_script(req)

    # ------------------------------------------------------------------ presets
    @r.get("/presets", response_model=list[Preset], tags=["presets"], operation_id="listPresets")
    def list_presets() -> list[Preset]:
        return service.presets()

    @r.post("/presets", response_model=Preset, tags=["presets"], operation_id="createPreset")
    def create_preset(preset: Preset) -> Preset:
        return service.create_preset(preset)

    @r.put("/presets/{preset_id}", response_model=Preset, tags=["presets"], operation_id="updatePreset")
    def update_preset(preset_id: str, preset: Preset) -> Preset:
        return service.update_preset(preset_id, preset)

    @r.delete("/presets/{preset_id}", status_code=204, response_class=Response, tags=["presets"], operation_id="deletePreset")
    def delete_preset(preset_id: str) -> Response:
        service.delete_preset(preset_id)
        return Response(status_code=204)

    # ------------------------------------------------------------------ render & export
    @r.post("/render", response_model=RenderInfo, tags=["render"], operation_id="render")
    def render(req: RenderRequest) -> RenderInfo:
        return service.render(req)

    @r.get("/renders/{render_id}", response_model=RenderInfo, tags=["render"], operation_id="getRender")
    def get_render(render_id: str) -> RenderInfo:
        return service.get_render(render_id)

    @r.post("/exports", response_model=ExportResult, tags=["export"], operation_id="createExports")
    def create_exports(req: ExportRequest) -> ExportResult:
        return service.create_exports(req)

    @r.post("/exports/rekordbox", response_model=RekordboxResult, tags=["export"], operation_id="exportRekordbox")
    def export_rekordbox(req: RekordboxRequest) -> RekordboxResult:
        return service.rekordbox(req)

    # ------------------------------------------------------------------ library
    @r.get("/library", response_model=LibraryPage, tags=["library"], operation_id="listLibrary")
    def list_library(q: str | None = None, starred: bool | None = None, preset_id: str | None = None,
                     limit: int = 50, offset: int = 0) -> LibraryPage:
        return service.library_page(q, starred, preset_id, limit, offset)

    @r.get("/library/{take_id}", response_model=Take, tags=["library"], operation_id="getTake")
    def get_take(take_id: str) -> Take:
        return service.get_take(take_id)

    @r.patch("/library/{take_id}", response_model=Take, tags=["library"], operation_id="updateTake")
    def update_take(take_id: str, patch: TakePatch) -> Take:
        return service.update_take(take_id, patch)

    @r.delete("/library/{take_id}", status_code=204, response_class=Response, tags=["library"], operation_id="deleteTake")
    def delete_take(take_id: str) -> Response:
        service.delete_take(take_id)
        return Response(status_code=204)

    # ------------------------------------------------------------------ batch
    @r.post("/batch", response_model=Job, tags=["batch"], operation_id="createBatch")
    def create_batch(req: BatchRequest) -> Job:
        return service.create_batch(req)

    # ------------------------------------------------------------------ settings & lexicon
    @r.get("/settings", response_model=Settings, tags=["settings"], operation_id="getSettings")
    def get_settings() -> Settings:
        return service.settings()

    @r.put("/settings", response_model=Settings, tags=["settings"], operation_id="updateSettings")
    def update_settings(settings: Settings) -> Settings:
        return service.update_settings(settings)

    @r.get("/lexicon", response_model=Lexicon, tags=["settings"], operation_id="getLexicon")
    def get_lexicon() -> Lexicon:
        return service.lexicon()

    @r.put("/lexicon", response_model=Lexicon, tags=["settings"], operation_id="updateLexicon")
    def update_lexicon(lexicon: Lexicon) -> Lexicon:
        return service.update_lexicon(lexicon)

    # ------------------------------------------------------------------ audio
    @r.get("/audio/{audio_id}", response_class=Response, tags=["audio"], operation_id="getAudio",
           responses={200: {"content": {"audio/wav": {"schema": {"type": "string", "format": "binary"}}},
                            "description": "WAV (integer PCM). `?token=` is accepted here instead of the header."}})
    def get_audio(audio_id: str) -> Response:
        return FileResponse(service.audio_path(audio_id), media_type="audio/wav")

    app.include_router(r)
    return app
