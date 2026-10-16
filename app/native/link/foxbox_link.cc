// FoxBox's Ableton Link (2.1): one Link session for the app, read by main about 60 times a second while it's on.
// enable(on) joins or leaves the network session; read(quantum) -> { bpm, beat, phase, peers, enabled }.
// Link is GPL-2.0-or-later (link/LICENSE.md), asio Boost-1.0; FoxBox is GPL-3.0. Built by scripts/build-link.sh.
#include <ableton/Link.hpp>
#include <node_api.h>

#include <memory>

static std::unique_ptr<ableton::Link> session;

// Created on first use and kept: a Link that was never enabled never touches the network.
static ableton::Link& link()
{
  if (!session) session = std::make_unique<ableton::Link>(120.0);
  return *session;
}

static napi_value arg(napi_env env, napi_callback_info info)
{
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  return argc > 0 ? argv[0] : nullptr;
}

static napi_value Enable(napi_env env, napi_callback_info info)
{
  bool on = false;
  if (napi_value a = arg(env, info)) napi_get_value_bool(env, a, &on);
  link().enable(on);
  return nullptr;
}

static void put(napi_env env, napi_value o, const char* key, double v)
{
  napi_value x;
  napi_create_double(env, v, &x);
  napi_set_named_property(env, o, key, x);
}

static napi_value Read(napi_env env, napi_callback_info info)
{
  double quantum = 4;
  if (napi_value a = arg(env, info)) napi_get_value_double(env, a, &quantum);
  if (!(quantum > 0)) quantum = 4;
  auto& l = link();
  const auto now = l.clock().micros();
  const auto state = l.captureAppSessionState();
  napi_value o, enabled;
  napi_create_object(env, &o);
  put(env, o, "bpm", state.tempo());
  put(env, o, "beat", state.beatAtTime(now, quantum));
  put(env, o, "phase", state.phaseAtTime(now, quantum));
  put(env, o, "peers", static_cast<double>(l.numPeers()));
  napi_get_boolean(env, l.isEnabled(), &enabled);
  napi_set_named_property(env, o, "enabled", enabled);
  return o;
}

NAPI_MODULE_INIT()
{
  napi_property_descriptor fns[] = {
    {"enable", nullptr, Enable, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, fns);
  // the session's threads stop with the app's environment, not at static teardown
  napi_add_env_cleanup_hook(env, [](void*) { session.reset(); }, nullptr);
  return exports;
}
