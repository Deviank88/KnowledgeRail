"""Offline, pinned local cross-encoder evaluation. No downloads or remote code."""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--output", default="benchmarks/results/retrieval-extension-292")
parser.add_argument("--batch", type=int, default=16)
parser.add_argument("--serve", action="store_true")
parser.add_argument("--port-file", default="/private/tmp/kr292-reranker-port.json")
args = parser.parse_args()
directory, output = Path(args.model), Path(args.output)
pairs = {}
for file in sorted(output.glob("*-reranker-pairs.json")):
    pairs.update(json.loads(file.read_text()))
assert pairs
torch.set_num_threads(4)
start = time.perf_counter()
tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True)
model = AutoModelForSequenceClassification.from_pretrained(directory, local_files_only=True).eval()
load_ms = (time.perf_counter() - start) * 1000
if args.serve:
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ready")

        def do_POST(self):
            if self.path == "/shutdown":
                self.send_response(200)
                self.end_headers()
                threading.Thread(target=self.server.shutdown).start()
                return
            size = int(self.headers.get("Content-Length", "0"))
            if self.path != "/rerank" or size <= 0 or size > 200000:
                self.send_error(400)
                return
            data = json.loads(self.rfile.read(size))
            documents, query = data["documents"], data["query"]
            if len(documents) > 64:
                self.send_error(400)
                return
            scores = []
            started = time.perf_counter()
            with torch.inference_mode():
                for offset in range(0, len(documents), args.batch):
                    batch = documents[offset:offset + args.batch]
                    inputs = tokenizer([query] * len(batch), batch, padding=True, truncation=True, max_length=512, return_tensors="pt")
                    scores.extend(model(**inputs).logits.flatten().tolist())
            body = json.dumps({"results": [{"index": i, "relevance_score": score} for i, score in enumerate(scores)]}).encode()
            print(json.dumps({"documents": len(documents), "inferenceMs": (time.perf_counter() - started) * 1000}), flush=True)
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    Path(args.port_file).write_text(json.dumps({"port": server.server_port, "loadMs": load_ms}))
    server.serve_forever()
    server.server_close()
    raise SystemExit(0)
rows = sorted(pairs.items(), key=lambda row: len(row[1]["query"]) + len(row[1]["document"]))
scores, timings = {}, []
with torch.inference_mode():
    for offset in range(0, len(rows), args.batch):
        batch = rows[offset:offset + args.batch]
        started = time.perf_counter()
        inputs = tokenizer([v["query"] for _, v in batch], [v["document"] for _, v in batch],
                           padding=True, truncation=True, max_length=512, return_tensors="pt")
        logits = model(**inputs).logits.flatten().tolist()
        timings.append({"pairs": len(batch), "tokens": inputs["input_ids"].shape[1], "ms": (time.perf_counter() - started) * 1000})
        scores.update({key: score for (key, _), score in zip(batch, logits)})
        if offset % 256 == 0:
            print(json.dumps({"completed": len(scores), "pairs": len(rows), "seconds": time.perf_counter() - start}), flush=True)
        if offset % 1024 == 0:
            (output / "reranker-progress.json").write_text(json.dumps({"completed": len(scores), "pairs": len(rows)}))
assert len(scores) == len(pairs)
result = {"descriptor": {"id": "local-cross-encoder", "model": "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1", "version": directory.name},
          "scores": scores, "loadMs": load_ms, "totalMs": (time.perf_counter() - start) * 1000,
          "device": "cpu", "threads": 4, "torch": torch.__version__, "maximumTokens": 512,
          "timings": timings, "pairDigest": hashlib.sha256(json.dumps(pairs, sort_keys=True).encode()).hexdigest()}
(output / "reranker-scores.json").write_text(json.dumps(result))
print(json.dumps({"completed": len(scores), "loadMs": load_ms, "totalMs": result["totalMs"]}), flush=True)
