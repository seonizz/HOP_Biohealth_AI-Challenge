import copy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from contextlib import nullcontext
import importlib.util
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from json_guard import JsonGuardError, JsonSchemaGuard, audit_schema, response_schema, strict_json_loads


SCHEMA = {'type': 'object', 'properties': {
    'answer': {'type': 'string', 'minLength': 1, 'maxLength': 20},
    'citations': {'type': 'array', 'items': {'enum': [{'quote': '합성 근거', 'id': 'q1'}]}, 'maxItems': 2},
    'choice': {'anyOf': [{'const': None}, {'type': 'boolean'}]}},
    'required': ['answer', 'citations', 'choice'], 'additionalProperties': False}


class FakeCompiler:
    def __init__(self, info, **options):
        self.info, self.options, self.calls = info, options, []
        self.fail = False

    def compile_json_schema(self, schema, **options):
        self.calls.append((copy.deepcopy(schema), options))
        if self.fail:
            raise RuntimeError('synthetic native failure')
        return object()


class FakeMatcher:
    def __init__(self, compiled):
        self.compiled, self.tokens = compiled, []

    def accept_token(self, token):
        if self.is_terminated() or token == 8:
            return False
        self.tokens.append(token)
        return True

    def is_terminated(self):
        return bool(self.tokens) and self.tokens[-1] == 9


class FakeProcessor:
    def __init__(self, compiled):
        self.compiled = compiled


def fake_guard(eos=None, shape=(10, 4)):
    model = SimpleNamespace(generation_config=SimpleNamespace(eos_token_id=[9] if eos is None else eos),
                            get_output_embeddings=lambda: SimpleNamespace(weight=SimpleNamespace(shape=shape)))
    xgr = SimpleNamespace(TokenizerInfo=SimpleNamespace(from_huggingface=lambda tokenizer, **options: options),
                          GrammarCompiler=FakeCompiler, GrammarMatcher=FakeMatcher)
    return JsonSchemaGuard(model, 'tokenizer', xgr=xgr, processor_class=FakeProcessor)


class GuardTests(unittest.TestCase):
    def test_valid_nested_schema_and_literal_keyword_names(self):
        self.assertIs(audit_schema(SCHEMA), SCHEMA)
        literal = {'enum': [{'anyOf': ['not a schema'], 'pattern': 'literal', 'properties': {'x': 1}}]}
        self.assertIs(audit_schema(literal), literal)
        self.assertEqual(audit_schema({'type': 'object', 'properties': {}, 'required': [], 'additionalProperties': False})['properties'], {})

    def test_unsupported_keywords_and_ignored_siblings_are_rejected(self):
        rejected = [
            {'type': 'array', 'items': {'type': 'string'}, 'uniqueItems': True},
            {'type': 'string', 'pattern': '^x'}, {'type': ['string', 'null']},
            {'enum': ['x'], 'type': 'string'}, {'const': None, 'type': 'null'},
            {'anyOf': [{'type': 'string'}], 'maxLength': 2},
            {'enum': ['x'], 'const': 'x'}, {'anyOf': []}, {'enum': []}, {}, True,
            {'type': 'object', 'properties': {}, 'required': [], 'additionalProperties': True},
            {'type': 'object', 'properties': {}, 'required': ['missing'], 'additionalProperties': False},
            {'type': 'object', 'properties': {'a': {'type': 'string'}}, 'required': ['a', 'a'], 'additionalProperties': False},
            {'type': 'object', 'properties': {}, 'additionalProperties': False},
            {'type': 'array'}, {'type': 'array', 'items': {'type': 'string'}, 'minItems': True},
            {'type': 'string', 'minLength': -1}, {'type': 'string', 'maxLength': 1.5},
            {'type': 'string', 'minLength': 2, 'maxLength': 1},
            {'type': 'integer', 'maxLength': 2}, {'const': float('nan')}, {'const': '\ud800'},
        ]
        for value in rejected:
            with self.subTest(schema=value), self.assertRaises(JsonGuardError) as caught:
                audit_schema(value)
            self.assertEqual(caught.exception.code, 'unsupported_json_schema')

    def test_schema_envelope_requires_explicit_full_schema(self):
        envelope = {'type': 'json_schema', 'json_schema': {'name': 'app_output', 'strict': True, 'schema': SCHEMA}}
        self.assertIs(response_schema(envelope), SCHEMA)
        for value in [None, {'type': 'json_object'}, {**envelope, 'unexpected': True},
                      {**envelope, 'json_schema': {**envelope['json_schema'], 'strict': False}},
                      {**envelope, 'json_schema': {'name': 'app_output', 'strict': True}}]:
            with self.subTest(envelope=value), self.assertRaises(JsonGuardError):
                response_schema(value)

    def test_integer_bounds_preserve_inclusive_safe_integer_range(self):
        for schema in [{'type': 'integer', 'minimum': 0, 'maximum': 107},
                       {'type': 'integer', 'minimum': -10},
                       {'type': 'integer', 'maximum': 9007199254740991}]:
            self.assertEqual(audit_schema(schema), schema)
        for schema in [{'type': 'integer', 'minimum': 2, 'maximum': 1},
                       {'type': 'integer', 'minimum': True}, {'type': 'integer', 'minimum': 0.5},
                       {'type': 'integer', 'maximum': 9007199254740992},
                       {'type': 'number', 'minimum': 0}, {'type': 'string', 'maximum': 2}]:
            with self.subTest(schema=schema), self.assertRaises(JsonGuardError):
                audit_schema(schema)

    def test_strict_parser_rejects_duplicate_escaped_nested_and_nonfinite_values(self):
        self.assertEqual(strict_json_loads('{"한글":[true,null,1.5]}'), {'한글': [True, None, 1.5]})
        for raw in ['{"ok":true,"ok":false}', '{"o":{"x":1,"\\u0078":2}}',
                    '{"x":NaN}', '{"x":Infinity}', '{"x":-Infinity}', '{"x":1e999}',
                    '{"x":1}}', '{"x":', '"\\ud800"']:
            with self.subTest(raw=raw), self.assertRaises((ValueError, UnicodeError)):
                strict_json_loads(raw)

    def test_actual_vocab_and_all_stop_ids_are_used(self):
        guard = fake_guard(eos=[7, 9])
        self.assertEqual(guard.compiler.info, {'vocab_size': 10, 'stop_token_ids': [7, 9]})
        self.assertEqual(guard.compiler.options, {'max_threads': 2, 'cache_enabled': False})
        self.assertEqual(fake_guard(eos=9).stop_ids, [9])
        for eos in [[], [10], [-1], [True], [9, 9], '9', False]:
            with self.subTest(eos=eos), self.assertRaises(JsonGuardError):
                fake_guard(eos=eos)
        for shape in [(), (10,), (0, 4), (True, 4)]:
            with self.subTest(shape=shape), self.assertRaises(JsonGuardError):
                fake_guard(shape=shape)

    def test_fresh_processor_full_schema_and_compile_options_per_request(self):
        guard = fake_guard()
        first, second = guard.prepare(SCHEMA), guard.prepare(SCHEMA)
        self.assertIsNot(first.processor, second.processor)
        self.assertEqual(guard.compiler.calls, [(SCHEMA, {'strict_mode': True, 'any_order': False,
                                                        'any_whitespace': False, 'separators': (',', ':')})] * 2)
        self.assertEqual(first.evidence['separators'], [',', ':'])
        self.assertFalse(first.evidence['any_whitespace'])
        self.assertEqual(first.evidence['schema_sha256'], second.evidence['schema_sha256'])
        self.assertGreaterEqual(first.evidence['schema_compile_seconds'], 0)
        self.assertFalse(first.evidence['full_output_replayed'])

    def test_compiler_failure_has_no_unconstrained_fallback(self):
        guard = fake_guard(); guard.compiler.fail = True
        with self.assertRaises(JsonGuardError) as caught:
            guard.prepare(SCHEMA)
        self.assertEqual(caught.exception.code, 'schema_compilation_failed')
        self.assertEqual(len(guard.compiler.calls), 1)

    def test_final_eos_is_replayed_and_completion_recorded(self):
        prepared = fake_guard().prepare(SCHEMA)
        self.assertEqual(prepared.verify([1, 2, 9], '{"ok":true}', 3), {'ok': True})
        for field in ['full_output_replayed', 'eos_terminated', 'strict_json_parsed']:
            self.assertTrue(prepared.evidence[field])

    def test_truncated_invalid_early_eos_and_nonterminated_outputs_are_rejected(self):
        cases = [([], '{}', 8), ([1, 2], '{}', 2), ([1, 8, 9], '{}', 8),
                 ([1, 9, 9], '{}', 8), ([1, 9], '{}', 1), ([10, 9], '{}', 8),
                 ([1, 9], '{"x":1,"x":2}', 8), ([1, 9], '{} }', 8)]
        for tokens, content, cap in cases:
            with self.subTest(tokens=tokens, content=content), self.assertRaises(JsonGuardError):
                fake_guard().prepare(SCHEMA).verify(tokens, content, cap)
        guard = fake_guard(eos=7)
        with self.assertRaises(JsonGuardError) as caught:
            guard.prepare(SCHEMA).verify([1, 7], '{}', 8)
        self.assertEqual(caught.exception.code, 'constrained_output_incomplete')


if __name__=='__main__': unittest.main()
