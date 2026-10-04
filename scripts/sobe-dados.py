#!/usr/bin/env python3
"""Sync data/ to the private Hetzner bucket the site is deployed from.

data/ is not in git: the GitHub Action (.github/workflows/deploy.yml) pulls it
from the bucket and publishes it with the site on GitHub Pages. This script is
the other half: it uploads every file in data/ whose MD5 differs from the
object's ETag (single-part uploads, so the ETag is the MD5), and with --apaga
removes objects that no longer exist locally.

The .githooks/pre-push hook runs it before every push to main, so the bucket
is current by the time the push starts the deploy.

Credentials come from .env (S3_ENDPOINT, S3_REGION, S3_BUCKET,
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY); see the README.

Usage: python3 scripts/sobe-dados.py [--apaga] [--seco]
  --apaga  also delete objects missing from data/
  --seco   only list what would change
"""

import hashlib
import os
import sys
from pathlib import Path

import boto3

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PREFIX = "data/"
TYPES = {".json": "application/json", ".gz": "application/gzip"}


def load_env():
    env = ROOT / ".env"
    if not env.exists():
        raise SystemExit("sobe-dados: falta .env com as credenciais do bucket (veja o README)")
    for line in env.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    apaga = "--apaga" in sys.argv
    seco = "--seco" in sys.argv
    load_env()
    if not DATA.is_dir():
        raise SystemExit("sobe-dados: não há data/ para subir")
    bucket = os.environ["S3_BUCKET"]
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        region_name=os.environ.get("S3_REGION", "hel1"),
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    )

    remote = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=PREFIX):
        for o in page.get("Contents", []):
            remote[o["Key"]] = o["ETag"].strip('"')

    local = {PREFIX + p.name: p for p in sorted(DATA.iterdir()) if p.is_file() and not p.name.startswith(".")}
    up = [k for k, p in local.items() if remote.get(k) != md5(p)]
    gone = sorted(set(remote) - set(local))

    for k in up:
        p = local[k]
        print(f"  sobe  {k} ({p.stat().st_size / 1e6:.1f} MB)")
        if not seco:
            with open(p, "rb") as f:
                s3.put_object(Bucket=bucket, Key=k, Body=f, ContentType=TYPES.get(p.suffix, "application/octet-stream"))
    for k in gone:
        print(f"  {'apaga' if apaga else 'sobra'} {k}")
        if apaga and not seco:
            s3.delete_object(Bucket=bucket, Key=k)

    if not up and not (apaga and gone):
        print("sobe-dados: o bucket já está igual a data/")
    elif gone and not apaga:
        print("sobe-dados: há objetos sem arquivo local; rode com --apaga para removê-los")


if __name__ == "__main__":
    main()
