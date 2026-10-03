"""Builds Peridot's native components.

  python scripts/build_native.py            build everything
  python scripts/build_native.py hash       C password hasher  -> native/bin/peridot-hash(.exe)
  python scripts/build_native.py themes     Rust theme generator, then regenerate src/themes.js

The C hasher is optional at runtime (Peridot falls back to Node's crypto, which
produces identical hashes). src/themes.js is committed, so the Rust toolchain is
only needed when the themes change.
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXE = ".exe" if os.name == "nt" else ""
C_SRC = ROOT / "native" / "c" / "peridot_hash.c"
C_BUILD = ROOT / "native" / "c" / "build"
BIN_DIR = ROOT / "native" / "bin"
HASH_BIN = BIN_DIR / f"peridot-hash{EXE}"
THEMES_CRATE = ROOT / "native" / "rust" / "peridot-themes"
THEMES_OUT = ROOT / "src" / "themes.js"


VSWHERE = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / \
    "Microsoft Visual Studio" / "Installer" / "vswhere.exe"


def find_vcvars():
    if not VSWHERE.exists():
        return None
    r = subprocess.run(
        [str(VSWHERE),"-latest", "-products", "*",
         "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
         "-property", "installationPath"],
        capture_output=True, text=True,
    )
    path = r.stdout.strip().splitlines()
    if not path:
        return None
    vcvars = Path(path[0]) / "VC" / "Auxiliary" / "Build" / "vcvars64.bat"
    return vcvars if vcvars.exists() else None


def build_hash():
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    C_BUILD.mkdir(parents=True, exist_ok=True)
    vcvars = find_vcvars() if os.name == "nt" else None
    if vcvars:
        # A temp .bat sidesteps cmd.exe quoting rules for paths with spaces.
        bat = tempfile.NamedTemporaryFile("w", suffix=".bat", delete=False)
        bat.write(
            "@echo off\n"
            # vcvars64.bat itself expects vswhere on PATH
            f'set "PATH=%PATH%;{VSWHERE.parent}"\n'
            f'call "{vcvars}" >nul || exit /b 1\n'
            f'cl /nologo /O2 /W4 /WX "{C_SRC}" /Fe"{HASH_BIN}" /Fo"{C_BUILD}\\\\"\n'
        )
        bat.close()
        try:
            r = subprocess.run([bat.name])
        finally:
            os.unlink(bat.name)
        compiler = "MSVC"
    else:
        cc = next((c for c in ("cc", "gcc", "clang") if shutil.which(c)), None)
        if not cc:
            sys.exit("no C compiler found (install Visual Studio Build Tools, gcc or clang)")
        r = subprocess.run([cc, "-O2", "-Wall", "-Wextra", "-Werror", "-std=c99", "-o", str(HASH_BIN), str(C_SRC)])
        compiler = cc
    if r.returncode != 0 or not HASH_BIN.exists():
        sys.exit(f"C build failed ({compiler})")
    print(f"built {HASH_BIN.relative_to(ROOT)} with {compiler}")


def build_themes():
    if not shutil.which("cargo"):
        sys.exit("cargo not found — install Rust from https://rustup.rs")
    r = subprocess.run(["cargo", "build", "--release", "--quiet"], cwd=THEMES_CRATE)
    if r.returncode != 0:
        sys.exit("Rust build failed")
    gen = THEMES_CRATE / "target" / "release" / f"peridot-themes{EXE}"
    r = subprocess.run([str(gen), str(THEMES_OUT)])
    if r.returncode != 0:
        sys.exit("theme generation failed")


def main():
    targets = sys.argv[1:] or ["hash", "themes"]
    unknown = set(targets) - {"hash", "themes"}
    if unknown:
        sys.exit(f"unknown target(s): {', '.join(sorted(unknown))} (expected: hash, themes)")
    if "hash" in targets:
        build_hash()
    if "themes" in targets:
        build_themes()


if __name__ == "__main__":
    main()
