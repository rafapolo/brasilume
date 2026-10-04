#!/usr/bin/env python3
"""Repack data/<uf>.bin.gz from the extractor's raw layout into the compact one
the site reads.

Raw layout (extrai_estados_cnpj.py, write_points_soa): gzip of b"RAW2", u32 n,
then n lngs (f32), n lats (f32), n weights (u16), n years-since-1900 (u8).

Packed layout (what worker.js decodes), gzipped:

    header, 32 bytes little-endian
      4s  magic "BLP3"
      u32 n
      f64 lng0, f64 lat0   origin of the grid
      f64 q                grid step in degrees
    2 blocks of n LEB128 varints each
      dx  zigzag deltas of the x grid index
      dy  zigzag deltas of the y grid index
    n bytes: the year the point's oldest establishment opened, minus 1900
             (the "linha do tempo" slider hides points newer than its year)

The u16 weights are dropped: the map never reads them (dot size and light are
slider-controlled), and they would add ~10% to every download. The raw files
from the extractor keep them.

Points are snapped to a 1e-5 degree grid (~1.1 m, well under one pixel at the
map's max zoom) and sorted in Morton (Z-order) so neighbours on the map are
neighbours in the file: the deltas stay tiny and gzip packs them ~3.5x smaller
than the raw floats. Draw order does not matter, since dots are summed by
additive blending.

Files already in the packed layout are skipped, so it is safe to rerun.

Usage: python3 scripts/repack.py [data_dir]
"""

import gzip
import struct
import sys
from pathlib import Path

import numpy as np

MAGIC = b"BLP3"
MAGIC_SETORES = b"BLS1"
OLD_MAGICS = (b"BLP2",)
Q = 1e-5


def spread_bits(v):
    v = v.astype(np.uint64) & np.uint64(0xFFFFFFFF)
    for shift, mask in (
        (16, 0x0000FFFF0000FFFF),
        (8, 0x00FF00FF00FF00FF),
        (4, 0x0F0F0F0F0F0F0F0F),
        (2, 0x3333333333333333),
        (1, 0x5555555555555555),
    ):
        v = (v | (v << np.uint64(shift))) & np.uint64(mask)
    return v


def zigzag(a):
    a = a.astype(np.int64)
    return ((a << 1) ^ (a >> 63)).astype(np.uint64)


def varints(a):
    """LEB128-encode a uint64 array, vectorized one 7-bit group at a time."""
    a = a.astype(np.uint64)
    nbytes = np.ones(len(a), dtype=np.int64)
    rest = a >> np.uint64(7)
    while rest.any():
        nbytes += rest > 0
        rest >>= np.uint64(7)
    out = np.empty(int(nbytes.sum()), dtype=np.uint8)
    starts = np.concatenate(([0], np.cumsum(nbytes)[:-1]))
    v = a.copy()
    for k in range(int(nbytes.max())):
        live = nbytes > k
        more = nbytes[live] > k + 1
        out[starts[live] + k] = (v[live] & np.uint64(0x7F)).astype(np.uint8) | (more.astype(np.uint8) << 7)
        v[live] >>= np.uint64(7)
    return out.tobytes()


def repack(path):
    raw = gzip.decompress(path.read_bytes())
    if raw[:4] == MAGIC:
        return None
    if raw[:4] in OLD_MAGICS:
        raise SystemExit(f"{path}: layout BLP2 não tem ano; extraia de novo com extrai_estados_cnpj.py")
    if raw[:4] not in (b"RAW2", b"RAW3"):
        raise SystemExit(f"{path}: layout bruto sem ano; extraia de novo com extrai_estados_cnpj.py")
    setores = raw[:4] == b"RAW3"
    n = int(np.frombuffer(raw, "<u4", 1, 4)[0])
    o = 8
    lng = np.frombuffer(raw, "<f4", n, o).astype(np.float64)
    lat = np.frombuffer(raw, "<f4", n, o + 4 * n).astype(np.float64)
    year = np.frombuffer(raw, "u1", n, o + 10 * n)
    mask = np.frombuffer(raw, "<u4", n, o + 11 * n) if setores else None

    lng0, lat0 = float(lng.min()), float(lat.min())
    x = np.round((lng - lng0) / Q).astype(np.int64)
    y = np.round((lat - lat0) / Q).astype(np.int64)
    order = np.argsort(spread_bits(x) | (spread_bits(y) << np.uint64(1)), kind="stable")
    x, y, year = x[order], y[order], year[order]

    body = (
        struct.pack("<4sIddd", MAGIC, n, lng0, lat0, Q)
        + varints(zigzag(np.diff(x, prepend=0)))
        + varints(zigzag(np.diff(y, prepend=0)))
        + year.tobytes()
    )
    if setores:
        write_setores(path, mask[order])
    packed = gzip.compress(body, 9)
    before = path.stat().st_size
    path.write_bytes(packed)
    return before, len(packed)


def write_setores(path, mask):
    """<uf>.setores.bin.gz, fetched only once someone filters by sector, in
    the same point order as the packed file:

        header, 12 bytes little-endian: 4s magic "BLS1", u32 n, u32 m
        n bytes   the point's CNAE section (0 = A ... 20 = U), or 255 when the
                  address holds more than one
        3 blocks of m bytes: low, middle and high byte of the section mask of
                  each of those m points, in order (bit k = section A + k)

    Most addresses hold a single section (88% in AC), so one byte names it;
    the full mask is kept only for the rest. Smaller than the mask alone.
    """
    single = (mask & (mask - np.uint32(1))) == 0
    code = np.full(len(mask), 255, np.uint8)
    code[single] = np.log2(np.maximum(mask[single], 1)).astype(np.uint8)
    multi = mask[~single]
    body = (
        struct.pack("<4sII", MAGIC_SETORES, len(mask), len(multi))
        + code.tobytes()
        + b"".join(((multi >> np.uint32(8 * k)) & np.uint32(0xFF)).astype(np.uint8).tobytes() for k in range(3))
    )
    out = path.with_name(path.name.replace(".bin.gz", ".setores.bin.gz"))
    out.write_bytes(gzip.compress(body, 9))


def main():
    data = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "data"
    for path in sorted(p for p in data.glob("*.bin.gz") if ".setores." not in p.name):
        res = repack(path)
        if res is None:
            print(f"  {path.name}: already packed")
        else:
            print(f"  {path.name}: {res[0] / 1e6:.1f} MB -> {res[1] / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
