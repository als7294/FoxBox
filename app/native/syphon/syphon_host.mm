// Syphon for VISUALS (1.6, TouchDesigner's free route): receives a Syphon server's frames (TD's Syphon Spout Out TOP)
// and hands each frame's IOSurface to Electron's main process (sharedTexture.importSharedTexture → the stage and
// OUTPUT windows as a VideoFrame). Zero-copy where it can be, as every Syphon client draws (a rare torn frame is
// Syphon's norm). But Chromium imports only a surface tagged with the pixel format it's told ('BGRA'), and
// TouchDesigner's carry none: those are copied on the GPU into one of a few of ours, tagged BGRA, and handed over once
// the copy completes (nothing waits on it). Syphon (BSD-3, vendor/) is compiled in; Node-API only, so it loads in Node
// and in Electron's main process as is. A test server publishes a moving picture, so the path runs without TouchDesigner.
//
// JS (main thread):
//   servers() -> [{name, app, uuid}]
//   connect(uuid) -> bool    then take() at your frame rate: the newest frame since the last take, or null
//   take() -> {surface: Buffer (an IOSurfaceRef, retained), width, height, format: 'bgra', fourcc, seq} | null
//            fourcc: the surface's own pixel-format tag, always 'BGRA' (anything else is never handed over)
//   release(surface)         once Electron has let go of it (allReferencesReleased)
//   disconnect() / stats() -> {handler, taken, copied, dropped}
//   serve(name) / publish(rgba: Buffer, width, height) -> bool / unserve()
//            FoxBox's own server: its camera picture for TouchDesigner (rows top first, RGBA8)
//   launch(app, document, env?, args?)  opens `document` with the app at path `app` as a new instance, hidden, not
//                            activated (NSWorkspace; TouchDesigner for FoxBox), `env` {name: value} added to its
//                            environment, `args` its command line;
//                            then launched() -> its pid, 0 while opening, -1 failed
//   hideApp(pid) -> bool     hides that app if it shows (true when it did): a hidden-launched TouchDesigner still puts
//                            its editor window up as the project opens
//   testServer(name) / testPublish(seconds, width, height) / testStop()
//   testConvert(width, height) -> {srcFourcc, fourcc, pixel: [b, g, r, a]}: an untagged surface (TouchDesigner's kind)
//            through the same copy
// Polled, not called back: a thread-safe callback into Electron's main loop drained ~10 times a second, Syphon ~55.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import "SyphonMetalClient.h"
#import "SyphonMetalServer.h"
#import "SyphonServerDirectory.h"
#include <node_api.h>

#include <atomic>
#include <cmath>
#include <mutex>
#include <string>
#include <vector>

namespace {

id<MTLDevice> dev;
id<MTLCommandQueue> queue;
SyphonMetalClient *client;
SyphonMetalServer *testServer;
std::mutex mu;
IOSurfaceRef latest = nullptr;  // the newest frame's surface (retained), not yet taken
uint64_t seq = 0;
std::atomic<uint32_t> nHandler{0}, nTaken{0}, nCopied{0}, nDropped{0};

constexpr OSType BGRA = 'BGRA';  // kCVPixelFormatType_32BGRA: the tag Chromium wants for 'bgra'

// Our BGRA surfaces for frames that need the copy. Busy from the copy until it's replaced untaken or released by
// Electron; a held frame never gets written over. Under mu.
struct Slot {
  IOSurfaceRef s;
  bool busy;
};
std::vector<Slot> pool;
constexpr size_t POOL_MAX = 12;  // ~3.7 MB each at 1280 x 720: frames in flight to the window and the GPU process

IOSurfaceRef new_bgra_surface(size_t w, size_t h) {
  NSDictionary *props = @{(id)kIOSurfaceWidth: @(w), (id)kIOSurfaceHeight: @(h), (id)kIOSurfaceBytesPerElement: @4,
                          (id)kIOSurfacePixelFormat: @(BGRA)};
  return IOSurfaceCreate((__bridge CFDictionaryRef)props);
}

IOSurfaceRef claim(size_t w, size_t h) {
  for (auto &slot : pool) {
    if (slot.busy) continue;
    if (IOSurfaceGetWidth(slot.s) != w || IOSurfaceGetHeight(slot.s) != h) {
      IOSurfaceRef s = new_bgra_surface(w, h);
      if (!s) return nullptr;
      CFRelease(slot.s);
      slot.s = s;
    }
    slot.busy = true;
    return slot.s;
  }
  if (pool.size() >= POOL_MAX) return nullptr;  // Electron holds them all: skip this frame
  IOSurfaceRef s = new_bgra_surface(w, h);
  if (s) pool.push_back({s, true});
  return s;
}

void unclaim(IOSurfaceRef s) {
  for (auto &slot : pool)
    if (slot.s == s) slot.busy = false;
}

// The newest frame (takes a reference); the one it replaces, never taken, goes back.
void publish(IOSurfaceRef s) {
  std::lock_guard<std::mutex> lock(mu);
  if (latest) unclaim(latest), CFRelease(latest);
  latest = s;
  seq++;
}

// src copied on the GPU into one of ours, tagged BGRA; done(surface) once complete, done(nullptr) if it couldn't be.
void copy_to_bgra(id<MTLTexture> src, void (^done)(IOSurfaceRef)) {
  IOSurfaceRef dst;
  {
    std::lock_guard<std::mutex> lock(mu);
    dst = claim(src.width, src.height);
  }
  if (!dst) return nDropped++, done(nullptr);  // every surface still held: this frame is skipped
  MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                               width:src.width height:src.height mipmapped:NO];
  d.usage = MTLTextureUsageShaderRead;
  d.storageMode = MTLStorageModeShared;
  id<MTLTexture> out = [dev newTextureWithDescriptor:d iosurface:dst plane:0];
  id<MTLCommandBuffer> cb = [queue commandBuffer];
  id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
  [blit copyFromTexture:src toTexture:out];
  [blit endEncoding];
  [cb addCompletedHandler:^(id<MTLCommandBuffer> b) {
    (void)out;  // kept alive until the copy is done
    if (b.status == MTLCommandBufferStatusCompleted) return done(dst);
    {
      std::lock_guard<std::mutex> lock(mu);
      unclaim(dst);
    }
    done(nullptr);
  }];
  [cb commit];
}

void ensure_metal() {
  if (!dev) {
    dev = MTLCreateSystemDefaultDevice();
    queue = [dev newCommandQueue];
  }
}

// On Syphon's queue: the server's newest frame becomes `latest`.
void on_new_frame(SyphonMetalClient *c) {
  nHandler++;
  id<MTLTexture> src = [c newFrameImage];
  if (!src || src.pixelFormat != MTLPixelFormatBGRA8Unorm || !src.iosurface) return;
  IOSurfaceRef s = src.iosurface;
  if (IOSurfaceGetPixelFormat(s) == BGRA) return CFRetain(s), publish(s);  // zero-copy
  nCopied++;
  copy_to_bgra(src, ^(IOSurfaceRef dst) {
    if (dst) CFRetain(dst), publish(dst);
  });
}

#define ARGS(n)                     \
  size_t argc = n;                  \
  napi_value argv[n];               \
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr)

std::string str_arg(napi_env env, napi_value v) {
  size_t n = 0;
  napi_get_value_string_utf8(env, v, nullptr, 0, &n);
  std::string s(n, '\0');
  napi_get_value_string_utf8(env, v, s.data(), n + 1, &n);
  return s;
}

napi_value string_value(napi_env env, id s) {
  napi_value v;
  napi_create_string_utf8(env, [s isKindOfClass:[NSString class]] ? [s UTF8String] : "", NAPI_AUTO_LENGTH, &v);
  return v;
}

napi_value fourcc_value(napi_env env, IOSurfaceRef s) {
  OSType pf = IOSurfaceGetPixelFormat(s);
  char cc[5] = {char(pf >> 24), char(pf >> 16), char(pf >> 8), char(pf), 0};
  napi_value v;
  napi_create_string_utf8(env, pf ? cc : "", NAPI_AUTO_LENGTH, &v);
  return v;
}

napi_value Servers(napi_env env, napi_callback_info) {
  napi_value arr;
  napi_create_array(env, &arr);
  uint32_t k = 0;
  for (NSDictionary *d in [[SyphonServerDirectory sharedDirectory] servers]) {
    napi_value o;
    napi_create_object(env, &o);
    napi_set_named_property(env, o, "name", string_value(env, d[SyphonServerDescriptionNameKey]));
    napi_set_named_property(env, o, "app", string_value(env, d[SyphonServerDescriptionAppNameKey]));
    napi_set_named_property(env, o, "uuid", string_value(env, d[SyphonServerDescriptionUUIDKey]));
    napi_set_element(env, arr, k++, o);
  }
  return arr;
}

void drop_client() {
  [client stop];
  client = nil;
  std::lock_guard<std::mutex> lock(mu);
  if (latest) unclaim(latest), CFRelease(latest);
  latest = nullptr;
}

napi_value Connect(napi_env env, napi_callback_info info) {
  ARGS(1);
  drop_client();
  std::string uuid = str_arg(env, argv[0]);
  NSDictionary *desc = nil;
  for (NSDictionary *d in [[SyphonServerDirectory sharedDirectory] servers])
    if ([d[SyphonServerDescriptionUUIDKey] isEqualToString:@(uuid.c_str())]) desc = d;
  napi_value ok;
  napi_get_boolean(env, desc != nil, &ok);
  if (!desc) return ok;
  ensure_metal();
  client = [[SyphonMetalClient alloc] initWithServerDescription:desc device:dev options:nil
                                                newFrameHandler:^(SyphonMetalClient *c) { on_new_frame(c); }];
  return ok;
}

napi_value Take(napi_env env, napi_callback_info) {
  IOSurfaceRef s;
  uint64_t n;
  {
    std::lock_guard<std::mutex> lock(mu);
    s = latest;  // its reference goes to JS, until release()
    n = seq;
    latest = nullptr;
  }
  napi_value obj, buf, v;
  if (!s) {
    napi_get_null(env, &obj);
    return obj;
  }
  nTaken++;
  napi_create_object(env, &obj);
  void *out;
  napi_create_buffer_copy(env, sizeof(s), &s, &out, &buf);
  napi_set_named_property(env, obj, "surface", buf);
  napi_create_uint32(env, (uint32_t)IOSurfaceGetWidth(s), &v), napi_set_named_property(env, obj, "width", v);
  napi_create_uint32(env, (uint32_t)IOSurfaceGetHeight(s), &v), napi_set_named_property(env, obj, "height", v);
  napi_create_string_utf8(env, "bgra", NAPI_AUTO_LENGTH, &v), napi_set_named_property(env, obj, "format", v);
  napi_set_named_property(env, obj, "fourcc", fourcc_value(env, s));
  napi_create_double(env, (double)n, &v), napi_set_named_property(env, obj, "seq", v);
  return obj;
}

napi_value Release(napi_env env, napi_callback_info info) {
  ARGS(1);
  void *data = nullptr;
  size_t len = 0;
  napi_get_buffer_info(env, argv[0], &data, &len);
  if (len != sizeof(IOSurfaceRef)) return nullptr;
  IOSurfaceRef s = *static_cast<IOSurfaceRef *>(data);
  std::lock_guard<std::mutex> lock(mu);
  unclaim(s);
  CFRelease(s);
  return nullptr;
}

napi_value Disconnect(napi_env env, napi_callback_info) {
  drop_client();
  return nullptr;
}

napi_value Stats(napi_env env, napi_callback_info) {
  napi_value o, v;
  napi_create_object(env, &o);
  napi_create_uint32(env, nHandler, &v), napi_set_named_property(env, o, "handler", v);
  napi_create_uint32(env, nTaken, &v), napi_set_named_property(env, o, "taken", v);
  napi_create_uint32(env, nCopied, &v), napi_set_named_property(env, o, "copied", v);
  napi_create_uint32(env, nDropped, &v), napi_set_named_property(env, o, "dropped", v);
  return o;
}

SyphonMetalServer *ownServer;
id<MTLTexture> ownTex[3];  // a ring: one is uploaded while the GPU may still be reading the others
uint32_t ownNext = 0;

napi_value Serve(napi_env env, napi_callback_info info) {
  ARGS(1);
  ensure_metal();
  [ownServer stop];
  ownServer = [[SyphonMetalServer alloc] initWithName:@(str_arg(env, argv[0]).c_str()) device:dev options:nil];
  return nullptr;
}

napi_value Publish(napi_env env, napi_callback_info info) {
  ARGS(3);
  void *data = nullptr;
  size_t len = 0;
  uint32_t w = 0, h = 0;
  napi_get_buffer_info(env, argv[0], &data, &len);
  napi_get_value_uint32(env, argv[1], &w);
  napi_get_value_uint32(env, argv[2], &h);
  napi_value ok;
  bool fits = ownServer && w && h && len >= size_t(w) * h * 4;
  napi_get_boolean(env, fits, &ok);
  if (!fits) return ok;
  __strong id<MTLTexture> &tex = ownTex[ownNext++ % 3];
  if (!tex || tex.width != w || tex.height != h) {
    MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:w height:h mipmapped:NO];
    d.usage = MTLTextureUsageShaderRead;
    d.storageMode = MTLStorageModeShared;
    tex = [dev newTextureWithDescriptor:d];
  }
  [tex replaceRegion:MTLRegionMake2D(0, 0, w, h) mipmapLevel:0 withBytes:data bytesPerRow:w * 4];
  id<MTLCommandBuffer> cb = [queue commandBuffer];
  [ownServer publishFrameTexture:tex onCommandBuffer:cb imageRegion:NSMakeRect(0, 0, w, h) flipped:NO];
  [cb commit];
  return ok;
}

napi_value Unserve(napi_env env, napi_callback_info) {
  [ownServer stop];
  ownServer = nil;
  for (auto &t : ownTex) t = nil;
  return nullptr;
}

napi_value TestServer(napi_env env, napi_callback_info info) {
  ARGS(1);
  ensure_metal();
  [testServer stop];
  testServer = [[SyphonMetalServer alloc] initWithName:@(str_arg(env, argv[0]).c_str()) device:dev options:nil];
  return nullptr;
}

napi_value TestPublish(napi_env env, napi_callback_info info) {
  ARGS(3);
  double t;
  uint32_t w, h;
  napi_get_value_double(env, argv[0], &t);
  napi_get_value_uint32(env, argv[1], &w);
  napi_get_value_uint32(env, argv[2], &h);
  if (!testServer) return nullptr;
  static id<MTLTexture> tex;
  if (!tex || tex.width != w || tex.height != h) {
    MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w height:h mipmapped:NO];
    d.usage = MTLTextureUsageShaderRead | MTLTextureUsageRenderTarget;
    d.storageMode = MTLStorageModePrivate;
    tex = [dev newTextureWithDescriptor:d];
  }
  MTLRenderPassDescriptor *p = [MTLRenderPassDescriptor renderPassDescriptor];
  p.colorAttachments[0].texture = tex;
  p.colorAttachments[0].loadAction = MTLLoadActionClear;
  p.colorAttachments[0].storeAction = MTLStoreActionStore;
  p.colorAttachments[0].clearColor = MTLClearColorMake(0.5 + 0.5 * sin(t * 2.1), 0.5 + 0.5 * sin(t * 1.3), 0.5 + 0.5 * sin(t * 0.7), 1);
  id<MTLCommandBuffer> cb = [queue commandBuffer];
  [[cb renderCommandEncoderWithDescriptor:p] endEncoding];
  [testServer publishFrameTexture:tex onCommandBuffer:cb imageRegion:NSMakeRect(0, 0, w, h) flipped:NO];
  [cb commit];
  return nullptr;
}

napi_value TestStop(napi_env env, napi_callback_info) {
  [testServer stop];
  testServer = nil;
  return nullptr;
}

napi_value TestConvert(napi_env env, napi_callback_info info) {
  ARGS(2);
  uint32_t w, h;
  napi_get_value_uint32(env, argv[0], &w);
  napi_get_value_uint32(env, argv[1], &h);
  ensure_metal();
  NSDictionary *props = @{(id)kIOSurfaceWidth: @(w), (id)kIOSurfaceHeight: @(h), (id)kIOSurfaceBytesPerElement: @4};
  IOSurfaceRef src = IOSurfaceCreate((__bridge CFDictionaryRef)props);  // no pixel format, as TouchDesigner's
  IOSurfaceLock(src, 0, nullptr);
  for (size_t y = 0; y < h; y++) {
    uint8_t *row = (uint8_t *)IOSurfaceGetBaseAddress(src) + y * IOSurfaceGetBytesPerRow(src);
    for (size_t x = 0; x < w; x++) row[x * 4] = 10, row[x * 4 + 1] = 20, row[x * 4 + 2] = 30, row[x * 4 + 3] = 255;
  }
  IOSurfaceUnlock(src, 0, nullptr);
  MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w height:h mipmapped:NO];
  d.storageMode = MTLStorageModeShared;
  id<MTLTexture> tex = [dev newTextureWithDescriptor:d iosurface:src plane:0];
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block IOSurfaceRef out = nullptr;
  copy_to_bgra(tex, ^(IOSurfaceRef dst) {
    if (dst) CFRetain(dst), out = dst;
    dispatch_semaphore_signal(sem);
  });
  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  napi_value o, arr, v;
  napi_create_object(env, &o);
  napi_set_named_property(env, o, "srcFourcc", fourcc_value(env, src));
  if (out) {
    napi_set_named_property(env, o, "fourcc", fourcc_value(env, out));
    IOSurfaceLock(out, kIOSurfaceLockReadOnly, nullptr);
    const uint8_t *px = (const uint8_t *)IOSurfaceGetBaseAddress(out);
    napi_create_array(env, &arr);
    for (uint32_t i = 0; i < 4; i++) napi_create_uint32(env, px[i], &v), napi_set_element(env, arr, i, v);
    IOSurfaceUnlock(out, kIOSurfaceLockReadOnly, nullptr);
    napi_set_named_property(env, o, "pixel", arr);
    std::lock_guard<std::mutex> lock(mu);
    unclaim(out);
    CFRelease(out);
  }
  CFRelease(src);
  return o;
}

std::atomic<int> launchedPid{0};  // 0 opening, > 0 its pid, -1 failed

napi_value Launch(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  launchedPid = 0;
  NSWorkspaceOpenConfiguration *c = [NSWorkspaceOpenConfiguration configuration];
  c.createsNewApplicationInstance = YES;
  c.hides = YES;
  c.activates = NO;
  c.addsToRecentItems = NO;
  napi_valuetype t = napi_undefined;
  if (argc > 2) napi_typeof(env, argv[2], &t);
  if (t == napi_object) {  // extra environment variables for the new instance: {name: value}
    NSMutableDictionary *vars = [NSMutableDictionary dictionary];
    napi_value names;
    uint32_t n = 0;
    napi_get_property_names(env, argv[2], &names);
    napi_get_array_length(env, names, &n);
    for (uint32_t i = 0; i < n; i++) {
      napi_value k, v;
      napi_get_element(env, names, i, &k);
      napi_get_property(env, argv[2], k, &v);
      napi_valuetype vt;
      napi_typeof(env, v, &vt);
      if (vt == napi_string) vars[@(str_arg(env, k).c_str())] = @(str_arg(env, v).c_str());
    }
    c.environment = vars;
  }
  bool isArray = false;
  if (argc > 3) napi_is_array(env, argv[3], &isArray);
  if (isArray) {  // its command line, after the document (e.g. -NSAppSleepDisabled YES: App Nap off, this launch only)
    NSMutableArray *list = [NSMutableArray array];
    uint32_t n = 0;
    napi_get_array_length(env, argv[3], &n);
    for (uint32_t i = 0; i < n; i++) {
      napi_value v;
      napi_get_element(env, argv[3], i, &v);
      [list addObject:@(str_arg(env, v).c_str())];
    }
    c.arguments = list;
  }
  NSURL *app = [NSURL fileURLWithPath:@(str_arg(env, argv[0]).c_str())];
  NSURL *doc = [NSURL fileURLWithPath:@(str_arg(env, argv[1]).c_str())];
  [[NSWorkspace sharedWorkspace] openURLs:@[ doc ] withApplicationAtURL:app configuration:c
                       completionHandler:^(NSRunningApplication *a, NSError *err) {
                         if (a) [a hide];
                         launchedPid = a ? a.processIdentifier : -1;
                       }];
  return nullptr;
}

napi_value Launched(napi_env env, napi_callback_info) {
  napi_value v;
  napi_create_int32(env, launchedPid, &v);
  return v;
}

napi_value HideApp(napi_env env, napi_callback_info info) {
  ARGS(1);
  int32_t pid = 0;
  napi_get_value_int32(env, argv[0], &pid);
  NSRunningApplication *a = pid > 1 ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
  bool hid = a && !a.hidden && !a.terminated;
  if (hid) [a hide];
  napi_value v;
  napi_get_boolean(env, hid, &v);
  return v;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"servers", nullptr, Servers, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"connect", nullptr, Connect, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"take", nullptr, Take, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"disconnect", nullptr, Disconnect, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stats", nullptr, Stats, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"launch", nullptr, Launch, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"launched", nullptr, Launched, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hideApp", nullptr, HideApp, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"serve", nullptr, Serve, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"publish", nullptr, Publish, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"unserve", nullptr, Unserve, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"testServer", nullptr, TestServer, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"testPublish", nullptr, TestPublish, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"testStop", nullptr, TestStop, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"testConvert", nullptr, TestConvert, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
