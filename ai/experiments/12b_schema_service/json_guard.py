"""Audited JSON Schema subset for the isolated XGrammar 0.2.9 experiment.

This guard constrains syntax/schema only. The unchanged app must still validate
the original schema, exact source evidence and independent review decisions.
"""
import hashlib
import json
import math
import time


class JsonGuardError(ValueError):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def require(condition, code, message):
    if not condition:
        raise JsonGuardError(code, message)


def strict_json_loads(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate JSON key')
            result[key] = value
        return result

    def finite_float(value):
        result = float(value)
        if not math.isfinite(result):
            raise ValueError('Nonfinite JSON number')
        return result

    def constant(_value):
        raise ValueError('Nonfinite JSON constant')

    result = json.loads(text, object_pairs_hook=pairs, parse_float=finite_float,
                        parse_constant=constant)
    # Reject invalid Unicode scalar values as well as nonfinite native values.
    json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8')
    return result


def audit_schema(schema):
    """Reject unsupported keywords and converter precedence ambiguities.

    The bridge may reduce enum/const sibling constraints only after proving all
    literals against the original app schema. This worker accepts the reduced
    form, never silently ignores sibling constraints itself.
    """
    allowed = {'type', 'properties', 'required', 'additionalProperties', 'items',
               'minItems', 'maxItems', 'minLength', 'maxLength', 'description',
               'anyOf', 'enum', 'const', 'minimum', 'maximum'}

    def reject(condition):
        require(condition, 'unsupported_json_schema', 'Schema is outside the audited supported subset')

    def bounds(node, low, high):
        for key in (low, high):
            reject(key not in node or type(node[key]) is int and node[key] >= 0)
        reject(low not in node or high not in node or node[low] <= node[high])

    def visit(node, depth=0):
        reject(type(node) is dict and depth <= 64 and not set(node) - allowed)
        reject('description' not in node or isinstance(node['description'], str))
        special = set(node) & {'enum', 'const', 'anyOf'}
        if special:
            reject(len(special) == 1 and not set(node) - special - {'description'})
            kind = next(iter(special))
            if kind == 'anyOf':
                reject(type(node[kind]) is list and bool(node[kind]))
                for branch in node[kind]:
                    visit(branch, depth + 1)
            elif kind == 'enum':
                reject(type(node[kind]) is list and bool(node[kind]))
            # enum/const contents are literal JSON data, not schema nodes.
            return
        kind = node.get('type')
        reject(isinstance(kind, str) and kind in
               {'object', 'array', 'string', 'number', 'integer', 'boolean', 'null'})
        specific = {'object': {'properties', 'required', 'additionalProperties'},
                    'array': {'items', 'minItems', 'maxItems'},
                    'string': {'minLength', 'maxLength'},
                    'integer': {'minimum', 'maximum'}}.get(kind, set())
        reject(not set(node) - specific - {'type', 'description'})
        if kind == 'object':
            properties, required = node.get('properties'), node.get('required')
            reject(type(properties) is dict and all(isinstance(key, str) for key in properties))
            reject(node.get('additionalProperties') is False)
            reject(type(required) is list and all(isinstance(key, str) for key in required))
            reject(len(set(required)) == len(required) and set(required) <= set(properties))
            for child in properties.values():
                visit(child, depth + 1)
        elif kind == 'array':
            reject('items' in node)
            bounds(node, 'minItems', 'maxItems')
            visit(node['items'], depth + 1)
        elif kind == 'string':
            bounds(node, 'minLength', 'maxLength')
        elif kind == 'integer':
            for key in ('minimum', 'maximum'):
                reject(key not in node or type(node[key]) is int and abs(node[key]) <= 9007199254740991)
            reject('minimum' not in node or 'maximum' not in node or node['minimum'] <= node['maximum'])

    try:
        # Validate literal JSON values without interpreting literal object keys.
        serialized = json.dumps(schema, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        strict_json_loads(serialized)
        visit(schema)
    except JsonGuardError:
        raise
    except (TypeError, ValueError, OverflowError, RecursionError, UnicodeError):
        raise JsonGuardError('unsupported_json_schema', 'Schema is not valid bounded JSON') from None
    return schema


def response_schema(response_format):
    require(type(response_format) is dict and set(response_format) == {'type', 'json_schema'}
            and response_format['type'] == 'json_schema', 'unsupported_response_format',
            'This experiment requires an explicit strict JSON Schema response format')
    value = response_format['json_schema']
    require(type(value) is dict and set(value) == {'name', 'strict', 'schema'}
            and value['name'] == 'app_output' and value['strict'] is True,
            'unsupported_response_format', 'Invalid strict JSON Schema envelope')
    return audit_schema(value['schema'])


class GenerationGrammar:
    def __init__(self, guard, compiled, schema, compile_seconds):
        self.guard, self.compiled = guard, compiled
        self.processor = guard.processor_class(compiled)
        self.evidence = {'engine': 'xgrammar', 'version': '0.2.9',
                         'schema_sha256': hashlib.sha256(json.dumps(
                             schema, sort_keys=True, ensure_ascii=False,
                             separators=(',', ':'), allow_nan=False).encode()).hexdigest(),
                         'schema_compile_seconds': compile_seconds, 'strict_mode': True,
                         'any_order': False, 'any_whitespace': False,
                         'separators': [',', ':'], 'cache_enabled': False,
                         'fresh_processor': True, 'full_output_replayed': False,
                         'eos_terminated': False, 'strict_json_parsed': False}

    def verify(self, tokens, content, max_tokens):
        require(type(tokens) is list and 0 < len(tokens) <= max_tokens
                and all(type(token) is int and 0 <= token < self.guard.vocab_size for token in tokens)
                and tokens[-1] in self.guard.stop_ids,
                'constrained_output_incomplete', 'Constrained output did not end with a configured EOS')
        # The HF processor sees only tokens preceding the next decoding step.
        # Replay includes the final EOS which generate() may not pass to it.
        matcher = self.guard.xgr.GrammarMatcher(self.compiled)
        for token in tokens:
            require(matcher.accept_token(token), 'constrained_output_invalid',
                    'Generated token does not match the compiled schema')
        require(matcher.is_terminated(), 'constrained_output_incomplete',
                'Generated token sequence did not terminate the compiled schema')
        self.evidence.update(full_output_replayed=True, eos_terminated=True)
        try:
            result = strict_json_loads(content)
        except (TypeError, ValueError, OverflowError, RecursionError, UnicodeError):
            raise JsonGuardError('constrained_output_invalid', 'Decoded output is not strict JSON') from None
        self.evidence['strict_json_parsed'] = True
        return result


class JsonSchemaGuard:
    def __init__(self, model, tokenizer, *, xgr=None, processor_class=None):
        if xgr is None or processor_class is None:
            import importlib.metadata
            require(importlib.metadata.version('xgrammar') == '0.2.9',
                    'grammar_runtime_mismatch', 'Expected pinned XGrammar 0.2.9')
            import xgrammar as xgr
            from xgrammar.contrib.hf import LogitsProcessor
            processor_class = LogitsProcessor
        embedding = model.get_output_embeddings()
        shape = getattr(getattr(embedding, 'weight', None), 'shape', ())
        require(len(shape) == 2 and type(shape[0]) is int and shape[0] > 0,
                'grammar_runtime_mismatch', 'Cannot determine actual model output vocabulary')
        self.vocab_size = shape[0]
        eos = model.generation_config.eos_token_id
        self.stop_ids = [eos] if type(eos) is int else eos
        require(type(self.stop_ids) is list and bool(self.stop_ids)
                and all(type(token) is int and 0 <= token < self.vocab_size for token in self.stop_ids)
                and len(set(self.stop_ids)) == len(self.stop_ids),
                'grammar_runtime_mismatch', 'Expected valid model EOS token IDs')
        self.stop_ids = list(self.stop_ids)
        self.xgr, self.processor_class = xgr, processor_class
        info = xgr.TokenizerInfo.from_huggingface(tokenizer, vocab_size=self.vocab_size,
                                                stop_token_ids=self.stop_ids)
        self.compiler = xgr.GrammarCompiler(info, max_threads=2, cache_enabled=False)

    def prepare(self, schema):
        audit_schema(schema)
        started = time.perf_counter()
        try:
            compiled = self.compiler.compile_json_schema(schema, strict_mode=True, any_order=False,
                                                         any_whitespace=False, separators=(',', ':'))
            return GenerationGrammar(self, compiled, schema, time.perf_counter() - started)
        except Exception as error:
            raise JsonGuardError('schema_compilation_failed',
                                 'Could not compile the complete requested schema') from error
