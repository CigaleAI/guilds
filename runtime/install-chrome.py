#!/usr/bin/env python3
"""Install Google Chrome Stable on amd64, or keep Debian Chromium: on arm64, where Google
publishes no Chrome, and wherever BROWSER=chromium asks for an image without Chrome in it."""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

CHROME_DEB_URL = "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
DEB_PATH = Path("/tmp/google-chrome-stable_current_amd64.deb")


def install_stable_deb() -> None:
    print(f"downloading Google Chrome Stable: {CHROME_DEB_URL}", flush=True)
    urllib.request.urlretrieve(CHROME_DEB_URL, DEB_PATH)
    env = os.environ.copy()
    env["DEBIAN_FRONTEND"] = "noninteractive"
    subprocess.run(["apt-get", "update", "-qq"], check=True, env=env)
    subprocess.run(
        ["apt-get", "install", "-y", "--no-install-recommends", str(DEB_PATH)],
        check=True,
        env=env,
    )
    DEB_PATH.unlink(missing_ok=True)
    shutil.rmtree("/var/lib/apt/lists", ignore_errors=True)
    Path("/var/lib/apt/lists").mkdir(parents=True, exist_ok=True)
    if shutil.which("google-chrome") is None and shutil.which("google-chrome-stable") is None:
        raise SystemExit("google-chrome-stable did not provide a chrome binary")
    print("installed google-chrome-stable", flush=True)


def main() -> None:
    machine = platform.machine()
    if os.environ.get("BROWSER", "chrome") == "chromium":
        if shutil.which("chromium") is None:
            raise SystemExit("BROWSER=chromium requires the Debian chromium package")
        print("BROWSER=chromium: keeping Debian chromium", flush=True)
        return
    if machine == "aarch64":
        if shutil.which("chromium") is None:
            raise SystemExit("arm64 requires the Debian chromium package")
        print(
            "arm64: official Google Chrome is not published; using Debian chromium",
            flush=True,
        )
        return
    if machine != "x86_64":
        raise SystemExit(f"unsupported architecture {machine}")
    install_stable_deb()


if __name__ == "__main__":
    sys.exit(main())
