#!/usr/bin/env python3
"""Build data/cidades.json: the seat of every municipality, for the names layer.

Coordinates of the seats (sedes municipais, IBGE) come from the
kelvins/municipios-brasileiros table; population from the Censo 2022, SIDRA
table 4709 (população residente). Population orders the names: the bigger
city wins a clash and shows from farther out.

Output, JSON: `cidades`, rows of [lon, lat, name, uf, population, z], where z
is the first map zoom the name may show at: state capitals from the whole
country, the smallest towns only close in.

Usage: python3 scripts/cidades.py [out_file]
"""

import io
import json
import sys
import urllib.request
from pathlib import Path

import polars as pl

SEATS = "https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/csv/municipios.csv"
POPULATION = "https://apisidra.ibge.gov.br/values/t/4709/n6/all/v/93/p/2022"
UFS = {
    11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO",
    21: "MA", 22: "PI", 23: "CE", 24: "RN", 25: "PB", 26: "PE", 27: "AL", 28: "SE", 29: "BA",
    31: "MG", 32: "ES", 33: "RJ", 35: "SP", 41: "PR", 42: "SC", 43: "RS",
    50: "MS", 51: "MT", 52: "GO", 53: "DF",
}
# (minimum population, first zoom); capitals take the first tier whatever
# their size.
TIERS = [(500_000, 5), (150_000, 6), (50_000, 7), (15_000, 8), (0, 9)]
CAPITAL_ZOOM = 3


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def main():
    here = Path(__file__).resolve().parent.parent
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "data" / "cidades.json"

    seats = pl.read_csv(io.BytesIO(fetch(SEATS)))
    rows = json.loads(fetch(POPULATION))[1:]  # the first row is the header
    pop = pl.DataFrame({
        "codigo_ibge": [int(r["D1C"]) for r in rows],
        "pop": [int(r["V"]) if r["V"].isdigit() else 0 for r in rows],
    })

    zoom = pl.when(pl.col("capital") == 1).then(CAPITAL_ZOOM)
    for floor, z in TIERS:
        zoom = zoom.when(pl.col("pop") >= floor).then(z)

    df = (
        seats.join(pop, on="codigo_ibge", how="left")
        .with_columns(
            pl.col("pop").fill_null(0),
            pl.col("codigo_uf").replace_strict(UFS).alias("uf"),
        )
        .with_columns(zoom.alias("z"))
        .sort("pop", descending=True)
    )
    missing = df.filter(pl.col("pop") == 0).height
    if missing:
        print(f"{missing} municípios sem população", file=sys.stderr)

    cidades = [
        [round(lon, 4), round(lat, 4), nome, uf, p, z]
        for lon, lat, nome, uf, p, z in df.select("longitude", "latitude", "nome", "uf", "pop", "z").iter_rows()
    ]
    out.write_text(json.dumps({"cidades": cidades}, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(cidades)} cidades em {out}")


if __name__ == "__main__":
    main()
