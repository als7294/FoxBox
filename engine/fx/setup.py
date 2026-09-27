"""Builds ``fvwks_fx._airwin``: the vendored Airwindows effects (native/airwin, MIT) behind a small pybind11 module.
Everything else about the package lives in pyproject.toml.

The extension is optional: if it can't compile (no C++ toolchain) the package still installs and the rack runs
without the Airwindows stages (they're flagged in the rack descriptor and skipped with a render warning).
Set FVWKS_NO_NATIVE=1 to skip it on purpose."""

import os
from pathlib import Path

from pybind11.setup_helpers import Pybind11Extension, build_ext
from setuptools import setup

AIRWIN = Path("native") / "airwin"
EFFECTS = ("ToTape9", "Tube2", "DeRez4", "Galactic3")
SOURCES = [str(AIRWIN / "binding.cpp"), str(AIRWIN / "src" / "airwin_consolidated_base.cpp")]
for name in EFFECTS:
    SOURCES += [str(AIRWIN / "src" / "autogen_airwin" / f"{name}{part}.cpp") for part in ("", "Proc")]

EXTENSIONS = [
    Pybind11Extension(
        "fvwks_fx._airwin",
        SOURCES,
        include_dirs=[str(AIRWIN)],
        cxx_std=17,
        extra_compile_args=["-O2", "-w"],  # upstream code, compiled as is
        optional=True,
    )
]

setup(
    ext_modules=[] if os.environ.get("FVWKS_NO_NATIVE") == "1" else EXTENSIONS,
    cmdclass={"build_ext": build_ext},
)
