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


def make_jump_forward_decoder(grammar, *, streamer=None, deadline=None):
    """Opt-in HF 5.17 callable for the isolated, greedy batch-one experiment.

    Only XGrammar's token API supplies forced continuations. Tokenization may
    differ from ordinary greedy decoding, so this is not an output-equivalence
    optimization. Full output replay/JSON parsing and app review remain required.
    HF prepares prompt/cache kwargs and streams the prompt before this callable.
    ``streamer`` is also captured because 5.17's callable-kwargs extraction may
    discard the ordinary streamer argument. No HF LogitsProcessor may be mixed
    with this decoder's own fresh matcher.
    """
    captured_streamer = streamer

    def decode(self, input_ids, logits_processor, stopping_criteria, generation_config,
               streamer=None, synced_gpus=False, **model_kwargs):
        import torch

        supported = ('jump_forward_unsupported', 'Jump-forward supports only greedy cached text generation with batch one')
        require(input_ids.ndim == 2 and input_ids.shape[0] == 1 and input_ids.shape[1] > 0, *supported)
        require(generation_config.do_sample is False and generation_config.num_beams == 1
                and getattr(generation_config, 'num_return_sequences', 1) == 1
                and generation_config.return_dict_in_generate is False
                and generation_config.use_cache is True and model_kwargs.get('use_cache') is True
                and synced_gpus is False and not self.config.is_encoder_decoder
                and not getattr(generation_config, 'is_assistant', False)
                and getattr(generation_config, 'prefill_chunk_size', None) is None, *supported)
        require(not any(getattr(generation_config, key, False) for key in
                        ['output_scores', 'output_logits', 'output_attentions', 'output_hidden_states']), *supported)
        require(all(model_kwargs.get(key) is None for key in
                    ['inputs_embeds', 'encoder_outputs', 'assistant_model', 'token_type_ids']), *supported)
        require(logits_processor is not None and len(logits_processor) == 0,
                'jump_forward_logits_processors', 'Other logits processors cannot share the jump-forward matcher')
        require(callable(stopping_criteria) and (deadline is None or callable(deadline)), *supported)
        require(streamer is None or captured_streamer is None or streamer is captured_streamer,
                'jump_forward_streamer_conflict', 'Conflicting jump-forward streamers')
        active_streamer = streamer if streamer is not None else captured_streamer
        max_length = generation_config.max_length
        require(type(max_length) is int and max_length > 0, *supported)
        eos = generation_config.eos_token_id
        eos = [eos] if type(eos) is int else eos
        require(type(eos) is list and bool(eos) and all(type(token) is int for token in eos)
                and set(eos) == set(grammar.guard.stop_ids),
                'jump_forward_eos_mismatch', 'Generation EOS must match the compiled grammar')

        xgr = grammar.guard.xgr
        matcher = xgr.GrammarMatcher(grammar.compiled)
        require(callable(getattr(matcher, 'find_jump_forward_tokens', None)),
                'grammar_runtime_mismatch', 'The pinned token jump-forward API is required')
        bitmask = xgr.allocate_token_bitmask(1, grammar.guard.vocab_size)
        grammar.evidence.update(jump_forward_enabled=True, jump_forward_max_chunk=32,
                                forced_tokens=0, forced_chunks=0, sampled_tokens=0,
                                model_forward_calls=0, jump_forward_terminated=False,
                                jump_forward_stop_reason=None)

        def expired():
            return deadline is not None and bool(deadline(input_ids, None))

        try:
            if input_ids.shape[1] >= max_length or expired():
                grammar.evidence['jump_forward_stop_reason'] = 'max_length' if input_ids.shape[1] >= max_length else 'deadline'
                return input_ids
            grammar.evidence['model_forward_calls'] += 1
            outputs = self._prefill(input_ids, generation_config, model_kwargs, is_first_iteration=True)
            while input_ids.shape[1] < max_length:
                if expired():
                    grammar.evidence['jump_forward_stop_reason'] = 'deadline'
                    break
                forced = matcher.find_jump_forward_tokens()
                require(type(forced) is list and all(type(token) is int and 0 <= token < grammar.guard.vocab_size
                                                    and token not in grammar.guard.stop_ids for token in forced),
                        'constrained_output_invalid', 'Invalid token jump-forward continuation')
                is_forced = bool(forced)
                if is_forced:
                    tokens = forced[:min(32, max_length - input_ids.shape[1])]
                else:
                    logits = outputs.logits[:, -1].to(copy=True, dtype=torch.float32, device=input_ids.device)
                    require(logits.shape == (1, grammar.guard.vocab_size),
                            'grammar_runtime_mismatch', 'Logits and compiled vocabulary differ')
                    # The official CPU matcher fills a full-vocabulary CPU mask.
                    # XGrammar's mask kernel requires logits and mask on one device.
                    if logits.device.type != 'cuda':
                        logits = logits.to('cpu')
                    matcher.fill_next_token_bitmask(bitmask, 0)
                    xgr.apply_token_bitmask_inplace(logits, bitmask.to(logits.device))
                    token = int(torch.argmax(logits, dim=-1).item())
                    require(math.isfinite(float(logits[0, token].item())),
                            'constrained_output_invalid', 'No finite grammar-valid token logit')
                    tokens = [token]
                    del logits

                # Check every prefix, including inside a forced chunk. A stop or
                # deadline must never consume, stream or cache later forced tokens.
                chunk = input_ids.new_tensor([tokens])
                before = input_ids.shape[1]
                candidate = torch.cat([input_ids, chunk], dim=-1)
                accepted, stopped = 0, False
                for token in tokens:
                    if expired():
                        grammar.evidence['jump_forward_stop_reason'] = 'deadline'
                        stopped = True
                        break
                    require(matcher.accept_token(token), 'constrained_output_invalid',
                            'Generated token does not match the compiled schema')
                    accepted += 1
                    grammar.evidence['forced_tokens' if is_forced else 'sampled_tokens'] += 1
                    if is_forced and accepted == 1:
                        grammar.evidence['forced_chunks'] += 1
                    input_ids = candidate[:, :before + accepted]
                    terminated = matcher.is_terminated()
                    require(terminated == (token in grammar.guard.stop_ids),
                            'constrained_output_incomplete', 'Grammar termination must match a configured EOS')
                    criteria_stopped = bool(stopping_criteria(input_ids, None))
                    if terminated:
                        grammar.evidence.update(jump_forward_terminated=True, jump_forward_stop_reason='eos')
                        stopped = True
                    elif criteria_stopped:
                        grammar.evidence['jump_forward_stop_reason'] = 'stopping_criteria'
                        stopped = True
                    elif input_ids.shape[1] >= max_length:
                        grammar.evidence['jump_forward_stop_reason'] = 'max_length'
                        stopped = True
                    if stopped:
                        break
                if accepted:
                    if active_streamer is not None:
                        # Preserve the existing per-token TTFT/event contract while
                        # retaining batched GPU prefill. Transfer the chunk once.
                        emitted = chunk[:, :accepted].cpu()
                        for index in range(accepted):
                            active_streamer.put(emitted[:, index:index + 1])
                if stopped:
                    break
                model_kwargs = self._update_model_kwargs_for_generation(
                    outputs, model_kwargs, is_encoder_decoder=False, num_new_tokens=accepted)
                require(model_kwargs.get('past_key_values') is not None,
                        'jump_forward_cache_missing', 'Cached decoding requires the model cache')
                del outputs
                if expired():
                    grammar.evidence['jump_forward_stop_reason'] = 'deadline'
                    break
                model_inputs = self.prepare_inputs_for_generation(
                    input_ids, next_sequence_length=accepted, **model_kwargs)
                grammar.evidence['model_forward_calls'] += 1
                outputs = self(**model_inputs, return_dict=True)
            return input_ids
        finally:
            if active_streamer is not None:
                active_streamer.end()

    return decode
