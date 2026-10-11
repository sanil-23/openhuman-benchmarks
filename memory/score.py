"""Call pinned official scoring functions without importing unused BERT code.

AST extraction preserves the upstream function bodies verbatim. LME generates
the official prompt; LoCoMo uses its category-specific F1/abstention scorer.
"""
import ast
import collections
import contextlib
import io
import json
import pathlib
import string
import sys
import regex
import numpy as np
from nltk.stem import PorterStemmer

ROOT = pathlib.Path(__file__).resolve().parent

def functions(file, names, scope):
    tree = ast.parse((ROOT/'source'/file).read_text())
    kept = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert len(kept) == len(names)
    exec(compile(ast.Module(body=kept, type_ignores=[]), file, 'exec'), scope)
    return scope

def score(row):
    if row['dataset'] == 'longmemeval':
        scope = functions('lme-evaluate.py', ['get_anscheck_prompt'], {})
        return {'prompt': scope['get_anscheck_prompt'](row['reference']['type'], row['question'], row['reference']['answer'], row['answer'], row['reference']['abstention'])}
    names = ['normalize_answer', 'f1_score', 'f1', 'eval_question_answering']
    scope = functions('locomo-evaluate.py', names, {'regex': regex, 'string': string, 'Counter': collections.Counter, 'ps': PorterStemmer(), 'np': np})
    q = {**row['reference'], 'prediction': row['answer']}
    with contextlib.redirect_stdout(io.StringIO()):
        values, _, _ = scope['eval_question_answering']([q])
    return {'score': float(values[0]), 'metric': 'official-category-f1/abstention'}

if __name__ == '__main__':
    print(json.dumps(score(json.load(sys.stdin))))
