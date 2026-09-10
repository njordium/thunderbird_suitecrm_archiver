#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""
Render the add-on's icon to PNG at the sizes Thunderbird's toolbar uses.

Thunderbird's Customise Toolbar palette does not reliably rasterise an SVG, so
the button shows up blank. PNGs are generated here rather than committed as
opaque binaries, so the icon stays editable: change the drawing below and re-run.

Pure Python — no image libraries are available in this environment. Shapes are
drawn analytically at 4x and box-downsampled, which gives clean antialiasing.
"""
import math, struct, zlib, pathlib

SS = 4                       # supersampling factor
OUT = pathlib.Path(__file__).resolve().parent.parent / "src/icons"

# Palette, matching icon.svg.
BLUE  = (0x1a, 0x6e, 0xa8)
GREEN = (0x20, 0xa0, 0x5a)
WHITE = (0xff, 0xff, 0xff)


def dist_to_segment(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def render(size):
    """Draw at `size` px on a side, returning an RGBA byte buffer."""
    n = size * SS
    u = n / 64.0                       # the artwork is designed on a 64px grid
    buf = bytearray(n * n * 4)

    def put(x, y, rgb, a):
        if a <= 0:
            return
        i = (y * n + x) * 4
        sr, sg, sb, sa = buf[i], buf[i + 1], buf[i + 2], buf[i + 3]
        na = a + sa / 255.0 * (1 - a)
        if na <= 0:
            return
        for k in range(3):
            src = (sr, sg, sb)[k] / 255.0
            buf[i + k] = int(round(((rgb[k] / 255.0) * a + src * (sa / 255.0) * (1 - a)) / na * 255))
        buf[i + 3] = int(round(na * 255))

    def rounded_rect(x0, y0, x1, y1, r, rgb):
        for y in range(int(y0), int(y1) + 1):
            for x in range(int(x0), int(x1) + 1):
                cx = min(max(x, x0 + r), x1 - r)
                cy = min(max(y, y0 + r), y1 - r)
                d = math.hypot(x - cx, y - cy)
                if d <= r:
                    put(x, y, rgb, 1.0)

    def circle(cx, cy, r, rgb):
        for y in range(int(cy - r) - 1, int(cy + r) + 2):
            for x in range(int(cx - r) - 1, int(cx + r) + 2):
                if 0 <= x < n and 0 <= y < n and math.hypot(x - cx, y - cy) <= r:
                    put(x, y, rgb, 1.0)

    def polyline(points, width, rgb):
        half = width / 2.0
        xs = [p[0] for p in points]; ys = [p[1] for p in points]
        for y in range(max(0, int(min(ys) - half) - 1), min(n, int(max(ys) + half) + 2)):
            for x in range(max(0, int(min(xs) - half) - 1), min(n, int(max(xs) + half) + 2)):
                d = min(dist_to_segment(x, y, *points[i], *points[i + 1])
                        for i in range(len(points) - 1))
                if d <= half:
                    put(x, y, rgb, 1.0)

    # Envelope body.
    rounded_rect(4 * u, 14 * u, 60 * u, 52 * u, 5 * u, BLUE)
    # Flap.
    polyline([(4 * u, 19.5 * u), (32 * u, 38 * u), (60 * u, 19.5 * u)], 4.5 * u, WHITE)
    # Badge, with a white ring so it reads against the envelope.
    circle(49 * u, 45 * u, 14.6 * u, WHITE)
    circle(49 * u, 45 * u, 13 * u, GREEN)
    polyline([(43 * u, 45.2 * u), (47.2 * u, 49.5 * u), (55.2 * u, 41 * u)], 4 * u, WHITE)

    # Box-downsample the supersampled buffer.
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    i = (((y * SS + sy) * n) + (x * SS + sx)) * 4
                    pa = buf[i + 3]
                    r += buf[i] * pa; g += buf[i + 1] * pa; b += buf[i + 2] * pa; a += pa
            j = (y * size + x) * 4
            if a:
                out[j] = min(255, r // a); out[j + 1] = min(255, g // a); out[j + 2] = min(255, b // a)
            out[j + 3] = a // (SS * SS)
    return bytes(out)


def write_png(path, size, rgba):
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 19, 24, 32, 48, 64, 128):
        p = OUT / f"icon-{size}.png"
        write_png(p, size, render(size))
        print(f"   {p.name}  {p.stat().st_size} bytes")
