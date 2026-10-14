#!/usr/bin/env python3
"""Tonefield GPU probe: draws the same scene with Canvas 2D and WebGL in the WebKitGTK the app uses, prints fps for each."""
import os, sys, json
os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
try:
    import gi
    gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1")
except (ImportError, ValueError):
    sys.exit("Needs PyGObject: sudo pacman -S python-gobject")
from gi.repository import Gtk, WebKit2, GLib
here = os.path.dirname(os.path.abspath(__file__))
win = Gtk.Window(); win.set_default_size(int(os.environ.get("PW", 3440)), int(os.environ.get("PH", 1440)))
view = WebKit2.WebView(); s = view.get_settings(); s.set_enable_webgl(True)
win.add(view); win.connect("destroy", Gtk.main_quit)
def gl_libs():
    """Which GL driver the web process loaded: names NVIDIA, Mesa hardware, or Mesa software (llvmpipe)."""
    found = set()
    for pid in os.listdir("/proc"):
        if not pid.isdigit(): continue
        try:
            if b"WebKitWebProcess" not in open(f"/proc/{pid}/cmdline", "rb").read(): continue
            for line in open(f"/proc/{pid}/maps"):
                name = line.rsplit("/", 1)[-1].strip()
                if any(k in name.lower() for k in ("nvidia", "gallium", "dri", "swrast", "llvm", "radeon", "amdgpu", "libegl", "libgl")): found.add(name)
        except OSError: pass
    return sorted(found)
def on_title(v, _):
    t = v.get_title() or ""
    if t.startswith("DONE:"):
        r = json.loads(t[5:]); r["glLibs"] = gl_libs(); print(json.dumps(r, indent=1)); Gtk.main_quit()
view.connect("notify::title", on_title)
view.load_uri("file://" + os.path.join(here, "probe.html"))
win.show_all()
if os.environ.get("FULL", "1") == "1": win.fullscreen()
GLib.timeout_add_seconds(60, lambda: (print("timed out"), Gtk.main_quit()))
Gtk.main()
