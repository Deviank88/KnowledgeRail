#!/usr/bin/env python3
"""Explicit one-time preparation of the measured BGE Q8 GGUF for native Ollama.

Requires Python 3, a local Ollama installation and an already pulled source model.
No downloads, weight conversion, service configuration or MCP configuration changes.
Only the pinned source is accepted: its offsets and resulting SHA256 are verified.
"""
import hashlib
import pathlib
import re
import shutil
import struct
import subprocess
import tempfile

SOURCE_MODEL = "qllama/bge-reranker-v2-m3:q8_0"
TARGET_MODEL = "knowledgerail-bge-reranker-v2-m3:q8_0"
SOURCE_SHA = "4bf51534d8d1aebced4de6eca4a8a39bd207170b42e3dcffa7718d194771a713"
TARGET_SHA = "092f088dd16882bb872e09ac18b624534c6d53780006e31be6fefcc621246fc2"


def sha256(file):
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare(source, target):
    if sha256(source) != SOURCE_SHA:
        raise ValueError("Source weights differ from the verified BGE Q8 conversion; refusing to patch.")
    # Exact offsets of the SHA-pinned GGUF v3, not a general GGUF editor.
    metadata_end, tensor_info_end, data_start = 6820529, 6842908, 6842912
    key = b"bert.pooling_type"
    added = struct.pack("<Q", len(key)) + key + struct.pack("<II", 4, 4)
    with source.open("rb") as src, target.open("xb") as dest:
        header = bytearray(src.read(metadata_end))
        struct.pack_into("<Q", header, 16, struct.unpack_from("<Q", header, 16)[0] + 1)
        dest.write(header)
        dest.write(added)
        dest.write(src.read(tensor_info_end - metadata_end))
        dest.write(b"\0" * (-dest.tell() % 32))
        src.seek(data_start)
        shutil.copyfileobj(src, dest)
    if sha256(target) != TARGET_SHA:
        raise ValueError("Prepared model checksum mismatch; model will not be imported.")


def main():
    existing = subprocess.run(["ollama", "show", "--modelfile", TARGET_MODEL], capture_output=True, text=True)
    if existing.returncode == 0:
        if "sha256-" + TARGET_SHA in existing.stdout:
            print(TARGET_MODEL + " is already prepared.")
            return
        raise ValueError("Target name already contains different weights; refusing to replace it.")
    modelfile = subprocess.check_output(["ollama", "show", "--modelfile", SOURCE_MODEL], text=True)
    match = re.search(r"^FROM\s+(.+)$", modelfile, re.MULTILINE)
    if not match:
        raise ValueError("Ollama did not provide a local GGUF path.")
    source = pathlib.Path(match.group(1).strip().strip('"'))
    with tempfile.TemporaryDirectory(prefix="knowledgerail-reranker-") as directory:
        folder = pathlib.Path(directory)
        target = folder / "bge-rank-q8.gguf"
        prepare(source, target)
        recipe = folder / "Modelfile"
        recipe.write_text('FROM "' + target.as_posix() + '"\nTEMPLATE {{ .Prompt }}\nPARAMETER num_ctx 2048\nPARAMETER num_batch 2048\n', encoding="utf-8")
        subprocess.run(["ollama", "create", TARGET_MODEL, "-f", str(recipe)], check=True)
    print("Prepared " + TARGET_MODEL + "; model SHA256 " + TARGET_SHA)


if __name__ == "__main__":
    main()
