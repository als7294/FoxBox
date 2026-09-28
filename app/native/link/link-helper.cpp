// FoxBox Link helper: joins the Ableton Link session on the local network (Rekordbox, Ableton Live, Traktor, ...)
// and reports its tempo, beat and phase as one JSON line per ~16 ms on stdout. stdin takes commands, one per line:
//   enable 0|1     leave / join the session (joined at start)
//   quantum N      beats per phase cycle (4 = a bar; default 4)
//   tempo BPM      propose a tempo to the session
// It exits when stdin closes (the app went away).
#include <ableton/Link.hpp>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <string>
#include <thread>

int main() {
  ableton::Link link(120.0);
  std::atomic<bool> running{true};
  std::atomic<double> quantum{4.0};
  std::thread commands([&] {
    std::string line;
    while (std::getline(std::cin, line)) {
      try {
        if (line.rfind("enable ", 0) == 0) {
          link.enable(line.size() > 7 && line[7] == '1');
        } else if (line.rfind("quantum ", 0) == 0) {
          const double q = std::stod(line.substr(8));
          if (q >= 1.0 && q <= 64.0) quantum = q;
        } else if (line.rfind("tempo ", 0) == 0) {
          const double bpm = std::stod(line.substr(6));
          if (bpm >= 20.0 && bpm <= 999.0) {
            auto state = link.captureAppSessionState();
            state.setTempo(bpm, link.clock().micros());
            link.commitAppSessionState(state);
          }
        }
      } catch (...) {
        // a malformed command: ignored
      }
    }
    running = false;
  });
  link.enable(true);
  while (running) {
    const auto now = link.clock().micros();
    const auto state = link.captureAppSessionState();
    const double q = quantum;
    std::printf("{\"enabled\":%s,\"peers\":%zu,\"tempo\":%.4f,\"beat\":%.5f,\"phase\":%.5f,\"quantum\":%g,\"micros\":%lld}\n",
                link.isEnabled() ? "true" : "false", link.numPeers(), state.tempo(), state.beatAtTime(now, q),
                state.phaseAtTime(now, q), q, static_cast<long long>(now.count()));
    std::fflush(stdout);
    std::this_thread::sleep_for(std::chrono::milliseconds(16));
  }
  link.enable(false);
  commands.join();
  return 0;
}
