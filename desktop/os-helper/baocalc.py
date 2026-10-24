#!/usr/bin/env python3
"""Tiny GTK 3 calculator for the native proxy spike.

GTK 4 on this machine reports every widget at screen origin, so a pixel
cannot be resolved to a button. GTK 3 extents are real and move with the
window. Buttons 7, +, 5, = update the label. The drawing area has no
accessible name and no action.
"""

import argparse

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk


class Win(Gtk.Window):
    def __init__(self, x: int, y: int, w: int, h: int):
        super().__init__(title="BaoCalc")
        self.expr = ""
        self.set_default_size(w, h)
        self.move(x, y)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.add(box)
        self.label = Gtk.Label(label="0")
        box.pack_start(self.label, False, False, 0)
        row = Gtk.Box(spacing=8)
        box.pack_start(row, False, False, 0)
        for text in ("7", "+", "5", "="):
            button = Gtk.Button(label=text)
            button.connect("clicked", self.on_click, text)
            row.pack_start(button, True, True, 0)
        area = Gtk.DrawingArea()
        area.set_size_request(160, 80)
        box.pack_start(area, False, False, 0)
        self.connect("destroy", Gtk.main_quit)
        self.show_all()

    def on_click(self, _button, text: str):
        if text == "=":
            try:
                self.label.set_text(str(eval(self.expr)))
            except Exception:
                self.label.set_text("err")
            return
        self.expr += text
        self.label.set_text(self.expr)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--x", type=int, default=30)
    parser.add_argument("--y", type=int, default=40)
    parser.add_argument("--w", type=int, default=320)
    parser.add_argument("--h", type=int, default=200)
    args = parser.parse_args()
    Win(args.x, args.y, args.w, args.h)
    Gtk.main()


if __name__ == "__main__":
    main()
