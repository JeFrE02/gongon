#!/usr/bin/env python3
"""Generate the GonGon app icon (no external assets, stdlib only).

Draws a rounded-square night-blue tile with a geometric "G": off-white ring with a
notch on the right, amber bar + stem. Writes desktop/build/icon.png (1024),
desktop/build/icon.ico (Windows, multi-size) and desktop/build/icon.icns (macOS,
via iconutil when available).

Run:  python3 desktop/build/make-icons.py
"""
import math
import os
import struct
import subprocess
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))

BG_TOP = (0x10, 0x1C, 0x30)
BG_BOTTOM = (0x0B, 0x12, 0x20)
G_COLOR = (0xE8, 0xDF, 0xD0)
AMBER = (0xFF, 0xB4, 0x54)
RED = (0xE0, 0x50, 0x3C)   # the squad marker's cone-hat red

# geometry in 0..1 units
INSET = 0.055           # tile padding
RADIUS = 0.215          # tile corner radius
CX, CY = 0.5, 0.5
RING_R = 0.235
RING_T = 0.082
NOTCH_HI, NOTCH_LO = -48.0, 12.0   # degrees (screen: +y down) removed from the ring
BAR = (CX + 0.010, CY + 0.005, CX + 0.276, CY + 0.092)   # x0, y0, x1, y1 (absolute)
STEM = (CX + 0.172, CY + 0.086, CX + 0.276, CY + 0.190)
# cone hat sitting on the G, echoing the character marker (base-left, base-right, tip)
CONE = ((CX - 0.090, CY - 0.150), (CX + 0.090, CY - 0.150), (CX, CY - 0.365))


def smoothstep(edge0, edge1, x):
    t = min(1.0, max(0.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def inside_round_rect(x, y):
    lo, hi = INSET, 1.0 - INSET
    if x < lo or x > hi or y < lo or y > hi:
        return False
    r = RADIUS
    cx = min(max(x, lo + r), hi - r)
    cy = min(max(y, lo + r), hi - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def inside_triangle(x, y, tri):
    (ax, ay), (bx, by), (cx, cy) = tri
    d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
    d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
    d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
    return (d1 >= 0 and d2 >= 0 and d3 >= 0) or (d1 <= 0 and d2 <= 0 and d3 <= 0)


def part_at(x, y):
    """Return a colour tuple for an opaque sample, or None outside the tile."""
    if not inside_round_rect(x, y):
        return None
    dx, dy = x - CX, y - CY
    dist = math.hypot(dx, dy)
    ang = math.degrees(math.atan2(dy, dx))
    in_ring = abs(dist - RING_R) <= RING_T / 2 and not (NOTCH_HI <= ang <= NOTCH_LO)
    if BAR[0] <= x <= BAR[2] and BAR[1] <= y <= BAR[3]:
        return RED
    if STEM[0] <= x <= STEM[2] and STEM[1] <= y <= STEM[3]:
        return RED
    if inside_triangle(x, y, CONE):
        return RED
    if in_ring:
        return G_COLOR
    t = (y - INSET) / (1.0 - 2 * INSET)
    return tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * min(1.0, max(0.0, t))) for i in range(3))


def render(size):
    ss = 3 if size <= 256 else 2
    px = bytearray(size * size * 4)
    step = 1.0 / (size * ss)
    for py in range(size):
        for pxi in range(size):
            r = g = b = 0
            opaque = 0
            for sy in range(ss):
                y = (py * ss + sy + 0.5) * step
                for sx in range(ss):
                    x = (pxi * ss + sx + 0.5) * step
                    col = part_at(x, y)
                    if col:
                        r += col[0]; g += col[1]; b += col[2]; opaque += 1
            n = ss * ss
            if opaque:
                o = (pxi + py * size) * 4
                px[o] = r // opaque; px[o + 1] = g // opaque; px[o + 2] = b // opaque
                px[o + 3] = round(255 * opaque / n)
    return bytes(px)


def write_png(path, size, rgba):
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


def write_ico(path, sizes):
    """Multi-size ICO; each entry holds a PNG (supported since Vista)."""
    blobs = []
    for s in sizes:
        tmp = os.path.join(HERE, f".ico-{s}.png")
        write_png(tmp, s, render(s))
        with open(tmp, "rb") as fh:
            blobs.append((s, fh.read()))
        os.remove(tmp)
    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries = b""
    for s, data in blobs:
        entries += struct.pack("<BBBBHHII", 0 if s >= 256 else s, 0 if s >= 256 else s, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(path, "wb") as fh:
        fh.write(header + entries + b"".join(d for _, d in blobs))


def write_icns(big):
    iconset = os.path.join(HERE, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    for s in (16, 32, 128, 256, 512):
        write_png(os.path.join(iconset, f"icon_{s}x{s}.png"), s, render(s))
        write_png(os.path.join(iconset, f"icon_{s}x{s}@2x.png"), s * 2, render(s * 2))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(HERE, "icon.icns")], check=True)
    for name in os.listdir(iconset):
        os.remove(os.path.join(iconset, name))
    os.rmdir(iconset)


def main():
    write_png(os.path.join(HERE, "icon.png"), 1024, render(1024))
    print("wrote icon.png 1024x1024")
    write_ico(os.path.join(HERE, "icon.ico"), [16, 24, 32, 48, 64, 128, 256])
    print("wrote icon.ico 16..256")
    if sys.platform == "darwin":
        write_icns(1024)
        print("wrote icon.icns 16..1024")


if __name__ == "__main__":
    main()
