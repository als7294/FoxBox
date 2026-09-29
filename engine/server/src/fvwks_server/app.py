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
    BassGroove,
    BassPatch,
    BatchRequest,
    DrumKit,
    ErrorEnvelope,
    ExportRequest,
    ExportResult,
    FlipStyle,
    GrooveRenderRequest,
    GrooveRenderResult,
    Health,
    Job,
    Lexicon,
    LibraryPage,
    MaskInfo,
    MaskRecipeSave,
    MaskRename,
    SamplePack,
    SamplePackAdd,
    SamplePackUpdate,
    MashMatch,
    MashScanRequest,
    MashScanResult,
    Remix,
    RemixCreate,
    RemixExportRequest,
    RekordboxImportRequest,
    RekordboxLibrary,
    RemixBuildRequest,
    RemixExportResult,
    RemixPrefsResult,
    RemixUpdate,
    TakeFeedback,
    TakeFeedbackCreate,
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
    SongLyrics,
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
from .masks import MAX_RASTER, MEDIA
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

    @r.post("/rekordbox/library", response_model=RekordboxLibrary, tags=["songs"], operation_id="readRekordboxLibrary")
    async def read_rekordbox_library(file: UploadFile = File(...)) -> RekordboxLibrary:
        """v0.12: the user's rekordbox.xml (its bytes: no path crosses the API): its tracks with an opaque id each, their
        grid, key and cues and whether the file is on this Mac, and its playlists. Kept 30 min for POST
        /rekordbox/import. 400 bad_xml; 413 over 100 MB."""
        if file.size is not None and file.size > 100 << 20:
            raise ApiException(413, "file_too_large", "This rekordbox.xml is over 100 MB.",
                               hint="Export a playlist's tracks instead of the whole collection.")
        return _songs("rekordbox_library")(await file.read())

    @r.post("/rekordbox/import", response_model=Job, tags=["songs"], operation_id="importRekordboxTracks")
    def import_rekordbox_tracks(req: RekordboxImportRequest) -> Job:
        """v0.12: the chosen tracks become Songs with their Rekordbox grid, key and cues (a rekordbox_import job; the
        result lists imported, updated and skipped). 404 library_expired: choose the XML again."""
        return _songs("import_rekordbox")(req)

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

    @r.get("/sample-packs", response_model=list[SamplePack], tags=["remix"], operation_id="listSamplePacks")
    def list_sample_packs() -> list[SamplePack]:
        """v0.15: your drum sample packs. Enabled ones replace FoxBox's own one-shots for the roles they cover."""
        return service.list_sample_packs()

    @r.post("/sample-packs", response_model=Job, tags=["remix"], operation_id="addSamplePack")
    def add_sample_pack(req: SamplePackAdd) -> Job:
        """v0.15: a folder of your one-shots (from the OS folder picker, main process only), read where it is (a
        sample_scan job, one item per audio file). 400 not_a_folder, 404 missing."""
        return service.add_sample_pack(req)

    @r.patch("/sample-packs/{pack_id}", response_model=SamplePack, tags=["remix"], operation_id="updateSamplePack")
    def update_sample_pack(pack_id: str, req: SamplePackUpdate) -> SamplePack:
        return service.update_sample_pack(pack_id, req)

    @r.delete("/sample-packs/{pack_id}", status_code=204, response_class=Response, tags=["remix"],
              operation_id="deleteSamplePack")
    def delete_sample_pack(pack_id: str) -> Response:
        """v0.15: forget the pack; its files are never touched."""
        service.delete_sample_pack(pack_id)
        return Response(status_code=204)

    @r.post("/sample-packs/{pack_id}/rescan", response_model=Job, tags=["remix"], operation_id="rescanSamplePack")
    def rescan_sample_pack(pack_id: str) -> Job:
        """v0.15: read the pack's folder again (rename a file, e.g. 'Kick 01.wav', then RESCAN to correct its role)."""
        return service.rescan_sample_pack(pack_id)

    @r.get("/masks", response_model=list[MaskInfo], tags=["camera"], operation_id="listMasks")
    def list_masks() -> list[MaskInfo]:
        """v0.11.6: the user's imported face masks (the built-ins are app assets)."""
        return service.masks.list()

    @r.post("/masks", response_model=MaskInfo, tags=["camera"], operation_id="uploadMask")
    async def upload_mask(file: UploadFile = File(...), name: str = Form(...)) -> MaskInfo:
        """v0.11.6: a user mask: SVG <= 2 MB (re-checked: no script, foreignObject, on*= or outside refs) or PNG / WebP
        <= 16 MB and <= 4096 px a side (read from its header)."""
        if file.size is not None and file.size > MAX_RASTER:  # refuse before reading it into memory
            raise ApiException(400, "file_too_large", "Masks are limited to 16 MB.")
        data = await file.read(MAX_RASTER + 1)
        return await run_in_threadpool(service.masks.add, data, name)

    @r.post("/masks/recipes", response_model=MaskInfo, tags=["camera"], operation_id="saveMaskRecipe")
    def save_mask_recipe(req: MaskRecipeSave) -> MaskInfo:
        """v0.13: a MASKS character-creator mask: its recipe JSON (<= 256 KB, stored as-is, never evaluated) and a PNG
        thumbnail (<= 512 px, <= 1 MB) served at /image. 413 over a limit; 415 a thumbnail that isn't a PNG."""
        return service.masks.save_recipe(req)

    @r.put("/masks/{mask_id}/recipe", response_model=MaskInfo, tags=["camera"], operation_id="updateMaskRecipe")
    def update_mask_recipe(mask_id: str, req: MaskRecipeSave) -> MaskInfo:
        """v0.13: replace a character's name and recipe (and its thumbnail, when one is sent). 409 for an image mask."""
        return service.masks.save_recipe(req, mask_id)

    @r.get("/masks/{mask_id}/recipe", response_model=dict[str, dict], tags=["camera"], operation_id="getMaskRecipe")
    def get_mask_recipe(mask_id: str) -> dict[str, dict]:
        """v0.13: {"recipe": {...}} as saved. 409 for an image mask."""
        return {"recipe": service.masks.recipe(mask_id)}

    @r.get("/masks/{mask_id}/image", response_class=Response, tags=["camera"], operation_id="getMaskImage",
           responses={200: {"content": {m: {} for m in MEDIA.values()}}})
    def get_mask_image(mask_id: str) -> Response:
        """v0.11.6: the mask's image with its own Content-Type; an SVG comes with CSP default-src 'none'."""
        info, path = service.masks.get(mask_id)
        if not path.is_file():  # a character saved without a thumbnail
            raise NotFound("mask image", mask_id)
        headers = {"X-Content-Type-Options": "nosniff"}
        if info.format == "svg":
            headers["Content-Security-Policy"] = "default-src 'none'"
        return FileResponse(path, media_type=MEDIA[info.format], headers=headers)

    @r.patch("/masks/{mask_id}", response_model=MaskInfo, tags=["camera"], operation_id="renameMask")
    def rename_mask(mask_id: str, req: MaskRename) -> MaskInfo:
        """v0.15.2: rename a user mask, image or recipe (only its name changes). 404 for an id the server doesn't hold
        (the built-ins are the app's), 409 for a mask that isn't the user's."""
        return service.masks.rename(mask_id, req.name)

    @r.delete("/masks/{mask_id}", status_code=204, response_class=Response, tags=["camera"], operation_id="deleteMask")
    def delete_mask(mask_id: str) -> Response:
        """v0.11.6: a user mask."""
        service.masks.delete(mask_id)
        return Response(status_code=204)

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

    @r.post("/songs/{song_id}/lyrics", response_model=Job, tags=["songs"], operation_id="transcribeSongLyrics")
    def transcribe_song_lyrics(song_id: str) -> Job:
        """v0.10: timed lyrics (a song_lyrics job): from the vocals stem when the song has stems, else the mix."""
        return _songs("request_lyrics")(song_id)

    @r.get("/songs/{song_id}/lyrics", response_model=SongLyrics, tags=["songs"], operation_id="getSongLyrics")
    def get_song_lyrics(song_id: str) -> SongLyrics:
        """v0.10: the song's timed words (409 until its song_lyrics job is done)."""
        return _songs("lyrics")(song_id)

    @r.post("/remixes", response_model=Remix, tags=["remix"], operation_id="createRemix")
    def create_remix(req: RemixCreate) -> Remix:
        """v0.11: a new remix of song A (+ B for a mashup), empty until BUILD; starts stems on sources without them."""
        return _songs("create_remix")(req)

    @r.get("/remixes", response_model=list[Remix], tags=["remix"], operation_id="listRemixes")
    def list_remixes(song_id: str | None = None, recipe: str | None = None) -> list[Remix]:
        """v0.11.9: `song_id` / `recipe` narrow the list (RESUME)."""
        return _songs("list_remixes")(song_id, recipe)

    @r.get("/remixes/{remix_id}", response_model=Remix, tags=["remix"], operation_id="getRemix")
    def get_remix(remix_id: str) -> Remix:
        return _songs("get_remix")(remix_id)

    @r.patch("/remixes/{remix_id}", response_model=Remix, tags=["remix"], operation_id="updateRemix")
    def update_remix(remix_id: str, body: RemixUpdate) -> Remix:
        """v0.11: save the arrangement at the rev it was edited from (409 remix_conflict when it's stale)."""
        return _songs("update_remix")(remix_id, body)

    @r.post("/remixes/{remix_id}/feedback", response_model=TakeFeedback, tags=["remix"], operation_id="rateRemixTake")
    def rate_remix_take(remix_id: str, req: TakeFeedbackCreate) -> TakeFeedback:
        """v0.11.8: rate one take (404 when the remix has no take with that seed); ROLL learns from it."""
        return _songs("rate_take")(remix_id, req)

    @r.get("/remix-prefs", response_model=RemixPrefsResult, tags=["remix"], operation_id="getRemixPrefs")
    def get_remix_prefs() -> RemixPrefsResult:
        """v0.11.8: the per-style option counts ROLL leans on."""
        return _songs("remix_prefs")()

    @r.delete("/remix-prefs/{style}", status_code=204, response_class=Response, tags=["remix"], operation_id="resetRemixPrefs")
    def reset_remix_prefs(style: str) -> Response:
        """v0.11.8: RESET, forget one style's ratings."""
        _songs("reset_remix_prefs")(style)
        return Response(status_code=204)

    @r.post("/remixes/{remix_id}/build", response_model=Job, tags=["remix"], operation_id="buildRemix")
    def build_remix(remix_id: str, req: RemixBuildRequest | None = None) -> Job:
        """v0.11: the recipe → a draft arrangement (a remix_build job; a new rev). A mashup lines up on Remix.mash.
        v0.11.9: a take with a saved arrangement (you switched away from it) gets it back; `fresh` rebuilds it."""
        return _songs("build_remix")(remix_id, req)

    @r.post("/remixes/{remix_id}/prepare", response_model=Job, tags=["remix"], operation_id="prepareRemix")
    def prepare_remix(remix_id: str) -> Job:
        """v0.11: render every clip without audio at the remix tempo and key (a remix_prepare job). Clips gain their
        audio_id as they're ready (the playhead's first 16 bars and the first drop first): refetch the remix meanwhile."""
        return _songs("prepare_remix")(remix_id)

    @r.post("/remixes/{remix_id}/export", response_model=Job, tags=["remix"], operation_id="exportRemix")
    def export_remix(remix_id: str, req: RemixExportRequest) -> Job:
        """v0.11.4: the mixdown as AIFF / MP3, the Ableton Live 11 set (BETA), and (visuals) a new Song whose structure
        is the arrangement's (a remix_export job; GET /remixes/{id}/export has the result)."""
        return _songs("export_remix")(remix_id, req)

    @r.get("/remixes/{remix_id}/export", response_model=RemixExportResult, tags=["remix"], operation_id="getRemixExport")
    def get_remix_export(remix_id: str) -> RemixExportResult:
        """v0.11.4: the latest export of this remix (404 until one exists)."""
        return _songs("remix_export")(remix_id)

    @r.delete("/remixes/{remix_id}", status_code=204, response_class=Response, tags=["remix"], operation_id="deleteRemix")
    def delete_remix(remix_id: str) -> Response:
        _songs("delete_remix")(remix_id)
        return Response(status_code=204)

    @r.get("/patches", response_model=list[BassPatch], tags=["remix"], operation_id="listPatches")
    def list_patches() -> list[BassPatch]:
        """v0.11: the bass library (preview_audio_id streams a short audition)."""
        return _songs("list_patches")()

    @r.get("/kits", response_model=list[DrumKit], tags=["remix"], operation_id="listKits")
    def list_kits() -> list[DrumKit]:
        return _songs("list_kits")()

    @r.get("/flip-styles", response_model=list[FlipStyle], tags=["remix"], operation_id="listFlipStyles")
    def list_flip_styles() -> list[FlipStyle]:
        return _songs("list_flip_styles")()

    @r.get("/songs/{song_id}/bass/groove", response_model=BassGroove, tags=["remix"], operation_id="getBassGroove")
    def get_bass_groove(song_id: str, start_bar: int = Query(1, ge=1), bars: int | None = Query(None, ge=1, le=256)) -> BassGroove:
        """v0.11: BASS DNA of a section of the song's bass stem (409 stems_not_ready until it's split); cached."""
        return _songs("bass_groove")(song_id, start_bar, bars)

    @r.post("/grooves/render", response_model=GrooveRenderResult, tags=["remix"], operation_id="renderGroove")
    def render_groove(req: GrooveRenderRequest) -> GrooveRenderResult:
        """v0.11.4: a section's BASS DNA re-played on a patch (the A/B audition); cached."""
        return _songs("render_groove")(req)

    @r.post("/mash/scan", response_model=MashScanResult, tags=["remix"], operation_id="scanMash")
    def scan_mash(req: MashScanRequest) -> MashScanResult:
        """v0.11.4 MASH RADAR (synchronous, cached features only): the other songs' parts that fit one part of this
        song, ranked; songs not read yet are in `missing` (queued)."""
        return _songs("mash_scan")(req)

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
