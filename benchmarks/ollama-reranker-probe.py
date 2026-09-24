"""Bounded Ollama compatibility probe, not a retrieval-quality benchmark.

Uses the Qwen3 reranker prompt and requires both exact yes/no log probabilities.
Missing labels are rejected, never replaced with made-up scores or text labels.
No dependencies, downloads, model creation, or server configuration changes.
"""
import argparse
import hashlib
import json
import math
import time
import urllib.request
from pathlib import Path

PREFIX = ('<|im_start|>system\nJudge whether the Document meets the requirements based on '
          'the Query and the Instruct provided. Note that the answer can only be "yes" or "no".'
          '<|im_end|>\n<|im_start|>user\n')
SUFFIX = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
INSTRUCTION = 'Given a web search query, retrieve relevant passages that answer the query'


def score_response(response):
    positions = response.get('logprobs') or []
    values = {row['token']: row['logprob'] for row in positions[0].get('top_logprobs', [])} if positions else {}
    if not all(isinstance(values.get(label), (float, int)) and math.isfinite(values[label]) for label in ('yes', 'no')):
        return None, 'missing_yes_no_logprobs'
    delta = values['yes'] - values['no']
    return (1 / (1 + math.exp(-delta)) if delta >= 0 else math.exp(delta) / (1 + math.exp(delta))), None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', action='append', required=True, help='Already installed Ollama model; repeat to compare.')
    parser.add_argument('--base-url', default='http://127.0.0.1:11434')
    parser.add_argument('--pairs', type=Path, help='Frozen *-reranker-pairs.json from retrieval-extension-eval.ts.')
    parser.add_argument('--sample', type=int, default=20, choices=range(1, 101))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output already exists; choose a new path to preserve earlier observations.')

    def api(route, body=None):
        request = urllib.request.Request(args.base_url.rstrip('/') + '/api/' + route,
                                         data=None if body is None else json.dumps(body).encode(),
                                         headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)

    sanity_query = 'Quale formato usa KnowledgeRail per ridurre la memoria dei vettori?'
    pairs = [
        ('sanity-relevant', {'query': sanity_query, 'document': 'KnowledgeRail conserva i vettori quantizzati int8 in memoria per ridurre lo spazio rispetto ai float32.'}),
        ('sanity-unrelated', {'query': sanity_query, 'document': 'Il calendario mostra le festività nazionali e gli appuntamenti della settimana.'}),
    ]
    pair_digest = None
    if args.pairs:
        raw = args.pairs.read_bytes()
        pair_digest = hashlib.sha256(raw).hexdigest()
        seen = set()
        for key, pair in sorted(json.loads(raw).items()):
            if pair['query'] in seen:
                continue
            pairs.append((key, pair))
            seen.add(pair['query'])
            if len(seen) >= args.sample:
                break
    record = {'version': api('version'), 'installed': api('tags'), 'residentBefore': api('ps'),
              'pairsFileSha256': pair_digest, 'pairs': pairs, 'options': {'temperature': 0, 'num_predict': 1, 'num_ctx': 4096, 'repeat_penalty': 1, 'seed': 292},
              'prefix': PREFIX, 'suffix': SUFFIX, 'instruction': INSTRUCTION, 'rows': []}
    for model in args.model:
        for key, pair in pairs:
            prompt = PREFIX + '<Instruct>: ' + INSTRUCTION + '\n<Query>: ' + pair['query'] + '\n<Document>: ' + pair['document'] + SUFFIX
            start = time.perf_counter()
            response = api('generate', {'model': model, 'prompt': prompt, 'raw': True, 'stream': False,
                                       'logprobs': True, 'top_logprobs': 20, 'keep_alive': '15m', 'options': record['options']})
            score, reason = score_response(response)
            record['rows'].append({'model': model, 'pair': key, 'wallMs': (time.perf_counter() - start) * 1000,
                                   'score': score, 'rejectedReason': reason, 'response': response})
        rows = [row for row in record['rows'] if row['model'] == model]
        print(json.dumps({'model': model, 'pairs': len(rows), 'validScores': sum(row['score'] is not None for row in rows)}), flush=True)
    record['residentAfter'] = api('ps')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(record, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
