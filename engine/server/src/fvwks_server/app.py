"""FastAPI app (owned by S3). FoxBox 2.0 (contracts v1.0): STRINGS' REMIX only, songs and their stems; PLAY never
calls the engine.

Route signatures and models are the HTTP contract, exported to contracts/openapi.yaml by scripts/export_openapi.py,
and the drift test in engine/contracts/tests keeps them frozen. The bodies delegate to ``EngineService``.

Exposure: the engine binds 127.0.0.1 only (main.py). Every route needs ``Authorization: Bearer <token>``; only
``GET /api/audio/*`` also accepts ``?token=`` (for media elements). CORS is off unless ``--allow-origin`` is given
(dev only; the app proxies through Electron main). The engine never accepts client file paths, apart from the export
folder in Settings, which is validated, and a library the user picked in main's native dialog (POST
/api/library/sources), which only main can add: it needs ``X-FoxBox-Main: <token>`` as well, a header main's proxy
never forwards from the renderer (which never holds the token either).
"""

from __future__ import annotations

import hmac
import logging
from contextlib import asynccontextmanager
from urllib.parse import parse_qs

from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, File, Form, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from fvwks_contracts.models import (
    ApiError,
    ErrorEnvelope,
    Health,
    Job,
    LibraryPlaylist,
    LibrarySource,
    LibrarySourceAdd,
    LibraryTrackPage,
    ModelInfo,
    Settings,
    SignedModelManifest,
    Song,
    SongUpdate,
    StemFeatures,
)

from .config import VERSION, Config
from .errors import ApiException, NotFound
from .service import MAX_SONG_BYTES, EngineService

log = logging.getLogger("fvwks.engine")

ERRORS = {s: {"model": ErrorEnvelope} for s in (400, 401, 404, 409, 422, 500)}
_BINARY = lambda kind, desc: {200: {"content": {kind: {"schema": {"type": "string", "format": "binary"}}}, "description": desc}}  # noqa: E731
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

    # ------------------------------------------------------------------ songs & stems (REMIX)
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

    # ------------------------------------------------------------------ settings
    @r.get("/settings", response_model=Settings, tags=["settings"], operation_id="getSettings")
    def get_settings() -> Settings:
        return service.settings()

    @r.put("/settings", response_model=Settings, tags=["settings"], operation_id="updateSettings")
    def update_settings(settings: Settings) -> Settings:
        return service.update_settings(settings)

    # ------------------------------------------------------------------ the library wheel (v1.1)
    def main_only(request: Request) -> None:
        if config.token and not hmac.compare_digest(request.headers.get("x-foxbox-main", "").encode(), config.token.encode()):
            raise ApiException(403, "main_only", "Only FoxBox itself adds a library.", hint="Add it in Settings → Library.")

    @r.get("/library/sources", response_model=list[LibrarySource], tags=["library"], operation_id="listLibrarySources")
    def list_library_sources() -> list[LibrarySource]:
        return service.library_sources()

    @r.post("/library/sources", response_model=LibrarySource, tags=["library"], operation_id="addLibrarySource",
            dependencies=[Depends(main_only)], responses={403: {"model": ErrorEnvelope}})
    def add_library_source(body: LibrarySourceAdd) -> LibrarySource:
        """Main only (`X-FoxBox-Main`): a folder, rekordbox.xml or _Serato_ folder the user picked in the native dialog.
        Its first scan runs in the background (state scanning); adding the same one again returns it."""
        return service.add_library_source(body)

    @r.post("/library/sources/serato", response_model=LibrarySource, tags=["library"], operation_id="detectSeratoLibrary")
    def detect_serato_library() -> LibrarySource:
        """Serato's standard library on this Mac (~/Music/_Serato_, or Serato DJ 4's), no path needed. 404
        serato_not_found when there's none."""
        return service.detect_serato_library()

    @r.delete("/library/sources/{source_id}", status_code=204, response_class=Response, tags=["library"],
              operation_id="removeLibrarySource")
    def remove_library_source(source_id: str) -> Response:
        """Forgets the library's index; its files are never touched."""
        service.remove_library_source(source_id)
        return Response(status_code=204)

    @r.post("/library/sources/{source_id}/rescan", response_model=LibrarySource, tags=["library"],
            operation_id="rescanLibrarySource")
    def rescan_library_source(source_id: str) -> LibrarySource:
        return service.rescan_library_source(source_id)

    @r.get("/library/sources/{source_id}/playlists", response_model=list[LibraryPlaylist], tags=["library"],
           operation_id="listLibraryPlaylists")
    def list_library_playlists(source_id: str) -> list[LibraryPlaylist]:
        return service.library_playlists(source_id)

    @r.get("/library/tracks", response_model=LibraryTrackPage, tags=["library"], operation_id="listLibraryTracks")
    def list_library_tracks(source_id: str | None = None, playlist_id: str | None = None,
                            q: str | None = Query(default=None, max_length=200),
                            sort: Literal["added", "title", "artist", "bpm"] | None = Query(
                                default=None, description="Default: the playlist's order, else added (newest first)."),
                            offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=10_000)) -> LibraryTrackPage:
        """One page of tracks (up to 10,000: the wheel can take a whole filtered list at once): all libraries, one, or one
        playlist; `q` matches title, artist, album, genre and file name, every word."""
        return service.library_tracks(source_id=source_id, playlist_id=playlist_id, q=q, sort=sort, offset=offset,
                                      limit=limit)

    @r.get("/library/tracks/{track_id}/art", response_class=Response, tags=["library"], operation_id="getLibraryTrackArt",
           responses=_BINARY("image/jpeg", "The cover, at most 512 px (or a PNG when it couldn't be resized). 404 no_art: none."))
    def get_library_track_art(track_id: str) -> Response:
        path, mime = service.library_art(track_id)
        return FileResponse(path, media_type=mime, headers={"Cache-Control": "private, max-age=86400"})

    @r.get("/library/tracks/{track_id}/preview", response_class=Response, tags=["library"],
           operation_id="getLibraryTrackPreview",
           responses=_BINARY("audio/wav", "~20 s from 40% in (earlier on a short track), 16-bit WAV with 30 ms fades."))
    def get_library_track_preview(track_id: str) -> Response:
        return FileResponse(service.library_preview(track_id), media_type="audio/wav")

    @r.post("/library/tracks/{track_id}/song", response_model=Song, tags=["library"], operation_id="loadLibraryTrack")
    def load_library_track(track_id: str) -> Song:
        """Load it into REMIX: the upload's pipeline (analysis, then stems on request). A Rekordbox track with a fixed
        grid keeps it, its key and its cues. The same audio again returns the song it already is."""
        return service.load_library_track(track_id)

    # ------------------------------------------------------------------ audio
    @r.get("/audio/{audio_id}", response_class=Response, tags=["audio"], operation_id="getAudio",
           responses={200: {"content": {"audio/wav": {"schema": {"type": "string", "format": "binary"}}},
                            "description": "WAV (integer PCM). `?token=` is accepted here instead of the header."}})
    def get_audio(audio_id: str) -> Response:
        return FileResponse(service.audio_path(audio_id), media_type="audio/wav")

    app.include_router(r)
    return app
