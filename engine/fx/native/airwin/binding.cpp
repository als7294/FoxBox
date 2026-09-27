// fvwks_fx._airwin: a few Airwindows effects (MIT) for the FVWKS rack, without any plugin host.
//
// The DSP is the unmodified airwin2rack "consolidated" code in src/ (see README.md for the pinned commit). Each
// Effect owns one plugin instance: parameters are the plugins' own normalized 0..1 values, audio is [2, n] float32,
// and processing releases the GIL so renders on the engine's thread pools run in parallel.

#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <algorithm>
#include <cstdlib>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "src/airwin_consolidated_base.h"
#include "src/autogen_airwin/DeRez4.h"
#include "src/autogen_airwin/Galactic3.h"
#include "src/autogen_airwin/ToTape9.h"
#include "src/autogen_airwin/Tube2.h"

namespace py = pybind11;

namespace {

using Base = AirwinConsolidatedBase;
using Factory = std::function<std::unique_ptr<Base>()>;

template <typename T> Factory make() {
    return [] { return std::make_unique<T>(0); };
}

const std::map<std::string, std::pair<int, Factory>> &registry() {
    static const std::map<std::string, std::pair<int, Factory>> r = {
        {"ToTape9", {airwinconsolidated::ToTape9::kNumParameters, make<airwinconsolidated::ToTape9::ToTape9>()}},
        {"Tube2", {airwinconsolidated::Tube2::kNumParameters, make<airwinconsolidated::Tube2::Tube2>()}},
        {"DeRez4", {airwinconsolidated::DeRez4::kNumParameters, make<airwinconsolidated::DeRez4::DeRez4>()}},
        {"Galactic3", {airwinconsolidated::Galactic3::kNumParameters, make<airwinconsolidated::Galactic3::Galactic3>()}},
    };
    return r;
}

// The plugins seed their float dither from the C library's rand() in their constructors. Seeding it under a lock
// makes every instance (and so every render) reproducible, also when renders run concurrently.
std::mutex rand_mutex;

class Effect {
  public:
    Effect(const std::string &name, double sample_rate, unsigned seed) : name_(name) {
        const auto &r = registry();
        auto it = r.find(name);
        if (it == r.end())
            throw py::value_error("unknown Airwindows effect: " + name);
        if (!(sample_rate > 2000.0))
            throw py::value_error("sample rate must be above 2 kHz");
        n_params_ = it->second.first;
        {
            std::lock_guard<std::mutex> lock(rand_mutex);
            std::srand(seed);
            fx_ = it->second.second();
        }
        fx_->setSampleRate(static_cast<float>(sample_rate));
    }

    const std::string &name() const { return name_; }
    int n_params() const { return n_params_; }

    std::string param_name(int i) {
        check(i);
        char text[kVstMaxParamStrLen * 4] = {0};
        fx_->getParameterName(i, text);
        return text;
    }

    std::string param_display(int i) {
        check(i);
        char text[kVstMaxParamStrLen * 4] = {0};
        fx_->getParameterDisplay(i, text);
        return text;
    }

    float get(int i) {
        check(i);
        return fx_->getParameter(i);
    }

    void set(int i, float value) {
        check(i);
        fx_->setParameter(i, std::clamp(value, 0.0f, 1.0f));
    }

    // [2, n] float32 in, [2, n] float32 out. State carries over between calls, like a plugin between buffers.
    py::array_t<float> process(py::array_t<float, py::array::c_style | py::array::forcecast> x) {
        if (x.ndim() != 2 || x.shape(0) != 2)
            throw py::value_error("expected a [2, n] float32 array");
        const py::ssize_t n = x.shape(1);
        py::array_t<float> y({py::ssize_t{2}, n});
        if (n == 0)
            return y;
        float *in[2] = {const_cast<float *>(x.data(0, 0)), const_cast<float *>(x.data(1, 0))};
        float *out[2] = {y.mutable_data(0, 0), y.mutable_data(1, 0)};
        {
            py::gil_scoped_release release;
            constexpr py::ssize_t block = 1 << 16;
            for (py::ssize_t o = 0; o < n; o += block) {
                float *bi[2] = {in[0] + o, in[1] + o};
                float *bo[2] = {out[0] + o, out[1] + o};
                fx_->processReplacing(bi, bo, static_cast<VstInt32>(std::min(block, n - o)));
            }
        }
        return y;
    }

  private:
    void check(int i) const {
        if (i < 0 || i >= n_params_)
            throw py::index_error("parameter index out of range");
    }

    std::string name_;
    int n_params_{0};
    std::unique_ptr<Base> fx_;
};

} // namespace

PYBIND11_MODULE(_airwin, m) {
    m.doc() = "Airwindows effects (MIT, airwin2rack consolidated sources) for the FVWKS rack";
    m.def("effects", [] {
        std::vector<std::string> names;
        for (const auto &kv : registry())
            names.push_back(kv.first);
        return names;
    });
    py::class_<Effect>(m, "Effect")
        .def(py::init<const std::string &, double, unsigned>(), py::arg("name"), py::arg("sample_rate"),
             py::arg("seed") = 0u)
        .def_property_readonly("name", &Effect::name)
        .def_property_readonly("n_params", &Effect::n_params)
        .def("param_name", &Effect::param_name)
        .def("param_display", &Effect::param_display)
        .def("get", &Effect::get)
        .def("set", &Effect::set)
        .def("process", &Effect::process);
}
