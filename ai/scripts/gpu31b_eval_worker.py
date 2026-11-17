#!/usr/bin/env python3
"""Resident, deterministic step-4723 paired worker (JSONL stdin/stdout).

Launch only through gpu31b_eval_bootstrap.py. No training state is unpickled;
only the checkpoint-bound loader and safetensors adapter are used. Scale zero
uses PEFT's disable_adapter context; scale one leaves that adapter active.
"""
from contextlib import contextmanager, nullcontext
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
import uuid

BASE_ALIAS = 'malssi-gemma4-31b-base'
TRAINED_ALIAS = 'malssi-gemma4-31b-cards-final-step4723'
SPEED_SHA = '241190ee8b9d499e5e68c5fc62a138f68f0b55df8168ff085fae709454d80cb1'
CONTEXT_TOKENS, OUTPUT_TOKENS, REQUEST_SECONDS = 32768, 8192, 900
MAX_LINE_BYTES = 8 * 1024 * 1024
LORA_SOURCE_SHA = {
    'peft/tuners/tuners_utils.py': 'e7f99b2ac5766ea317bcb943619d8a2a2235057acb5b543a1973ae8938173659',
    'peft/peft_model.py': 'd22a1c50dea7a046ce28e71a79dfc20b1d96a2d238a9b457be6a88b6068e04d5',
    'peft/tuners/lora/bnb.py': '96ed6fda63d7c67a4646faea8ba38483e8be8670059a3ac3dd740a99bdab6950',
    'unsloth/kernels/utils.py': '2b542f17cd5555abc1fe8c5c95a9ce8d83da9d81b7c142015074477ab1418283',
}


class RequestError(ValueError):
    def __init__(self, code, message, evidence=None):
        self.code, self.message, self.evidence = code, message, evidence or {}
        super().__init__(message)


def check(ok, code, message):
    if not ok:
        raise RequestError(code, message)


def sha_file(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def sequence_sha(ids):
    return hashlib.sha256(json.dumps(ids, separators=(',', ':')).encode()).hexdigest()


def canonical_sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def atomic(work, report):
    target = work / 'WORKER_RESULT.json'
    if target.is_symlink():
        raise RuntimeError('Worker report must not be a symlink')
    temporary = work / ('.WORKER_RESULT.' + uuid.uuid4().hex)
    try:
        with temporary.open('x') as handle:
            json.dump(report, handle, sort_keys=True, allow_nan=False)
            handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)



def durable_emit(work, transport, value, report):
    """Commit a complete transport record before attempting pipe delivery.

    A closed observer pipe is a communication failure, not evidence that the
    already verified model/checkpoint changed. EOF on the input will still lead
    to final integrity checks and an independently durable closed record.
    """
    raw = (json.dumps(value, ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8')
    journal = work / 'transport-out.jsonl'
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(journal, flags, 0o600)
    try:
        with os.fdopen(fd, 'ab', closefd=False) as handle:
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
    finally:
        os.close(fd)
    if report.get('transport_status') == 'failed':
        return False
    try:
        transport.write(raw.decode('utf-8')); transport.flush()
        return True
    except (BrokenPipeError, OSError) as error:
        report.update(transport_status='failed', transport_error_type=type(error).__name__,
                      transport_failed_at=time.time(), transport_failed_record_sha256=hashlib.sha256(raw).hexdigest(),
                      durable_response_journal=str(journal))
        atomic(work, report)
        return False


def durable_input(work, line):
    raw = line.encode('utf-8')
    fd = os.open(work / 'transport-in.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(fd, 'ab', closefd=False) as handle:
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
    finally:
        os.close(fd)


def parse_payload(payload):
    check(isinstance(payload, dict), 'invalid_request', 'payload must be an object')
    allowed = {'model', 'messages', 'max_tokens', 'max_completion_tokens', 'temperature',
               'top_p', 'stream', 'n', 'seed', 'cache_prompt', 'lora', 'response_format', 'reasoning_effort'}
    check(not set(payload) - allowed, 'unsupported_parameter', 'Unsupported generation parameter')
    # This worker has no constrained-decoding implementation. Even json_object
    # must not silently turn into unvalidated free generation.
    check('response_format' not in payload, 'unsupported_response_format',
          'Constrained response_format is unsupported; use the explicit prompt-only profile')
    check(payload.get('stream', False) is False and type(payload.get('n', 1)) is int
          and payload.get('n', 1) == 1, 'unsupported_parameter', 'Requires stream=false and n=1')
    cap = payload.get('max_tokens', payload.get('max_completion_tokens'))
    check(type(cap) is int and 1 <= cap <= OUTPUT_TOKENS, 'invalid_max_tokens',
          'Specify an output cap between 1 and 8192')
    check('max_completion_tokens' not in payload or payload['max_completion_tokens'] == cap,
          'invalid_max_tokens', 'Conflicting output caps')
    temperature, top_p = payload.get('temperature', 0), payload.get('top_p', 1)
    check(type(temperature) in (int, float) and math.isfinite(temperature) and temperature == 0,
          'invalid_temperature', 'Controlled comparison requires temperature=0')
    check(type(top_p) in (int, float) and math.isfinite(top_p) and top_p == 1,
          'invalid_top_p', 'Controlled comparison requires top_p=1')
    check(type(payload.get('seed', 3407)) is int and payload.get('seed', 3407) == 3407,
          'invalid_seed', 'Controlled comparison requires seed=3407')
    check(payload.get('reasoning_effort', 'none') == 'none', 'unsupported_parameter',
          'Only reasoning_effort=none is supported')
    check(payload.get('cache_prompt', False) is False, 'unsupported_parameter',
          'Controlled comparison requires cache_prompt=false')
    lora = payload.get('lora')
    if lora is None:
        check(payload.get('model') in (BASE_ALIAS, TRAINED_ALIAS), 'model_not_found',
              'An explicit comparison model or LoRA scale is required')
        scale = 0 if payload['model'] == BASE_ALIAS else 1
    else:
        check(isinstance(lora, list) and len(lora) == 1 and isinstance(lora[0], dict)
              and set(lora[0]) == {'id', 'scale'}, 'invalid_lora', 'Requires exactly one id/scale LoRA entry')
        item = lora[0]
        check(type(item['id']) is int and item['id'] == 0 and type(item['scale']) in (int, float)
              and math.isfinite(item['scale']) and item['scale'] in (0, 1),
              'invalid_lora', 'Only adapter id 0 with scale 0 or 1 is supported')
        scale = int(item['scale'])
    alias = BASE_ALIAS if scale == 0 else TRAINED_ALIAS
    # The existing paired collector deliberately uses one serving alias for both
    # scales. The scale is the authoritative arm selection and is always recorded.
    check(payload.get('model', alias) in (BASE_ALIAS, TRAINED_ALIAS, 'paired-role-eval', 'malssi-gemma4-31b-controlled'),
          'model_not_found', 'Requested model is not the controlled 31B pair')
    check(payload.get('model') not in (BASE_ALIAS, TRAINED_ALIAS) or payload['model'] == alias,
          'model_lora_mismatch', 'Named comparison alias and explicit LoRA scale disagree')
    messages = payload.get('messages')
    check(isinstance(messages, list) and bool(messages), 'invalid_messages', 'messages must be a nonempty list')
    for message in messages:
        check(isinstance(message, dict) and set(message) == {'role', 'content'}
              and message['role'] in ('system', 'user', 'assistant') and isinstance(message['content'], str),
              'invalid_messages', 'Only text system/user/assistant messages are supported')
    return {'messages': messages, 'max_tokens': cap, 'temperature': 0, 'top_p': 1,
            'seed': 3407, 'scale': scale, 'model': alias}


class Deadline:
    def __init__(self, seconds=REQUEST_SECONDS, clock=time.monotonic, cancellation=None):
        self.clock, self.ends_at, self.expired = clock, clock() + seconds, False
        self.cancellation, self.cancelled = cancellation, False

    def __call__(self, input_ids, scores, **kwargs):
        self.expired = self.clock() >= self.ends_at
        self.cancelled = self.cancelled or bool(self.cancellation and self.cancellation())
        return self.expired or self.cancelled


def adapter_flags(model):
    """Inspect real tuner layers, not just the model's public context method."""
    result = {}
    for name, module in model.named_modules():
        if hasattr(module, 'lora_A') and hasattr(module, 'lora_B'):
            disabled = getattr(module, 'disable_adapters', None)
            if type(disabled) is not bool:
                raise RuntimeError('A LoRA layer exposes no boolean disable_adapters flag')
            if getattr(module, 'merged', False):
                raise RuntimeError('A merged LoRA cannot support a controlled disabled arm')
            active = getattr(module, 'active_adapters', None)
            if active is not None and list(active) != ['default']:
                raise RuntimeError('Unexpected active adapter selection')
            result[name] = disabled
    if not result:
        raise RuntimeError('No inspectable LoRA tuner layers were loaded')
    return result


@contextmanager
def selected_adapter(model, scale, evidence):
    before = adapter_flags(model)
    if any(before.values()):
        raise RuntimeError('Adapter must be enabled before each request')
    evidence['adapter_flags_before'] = before
    try:
        with model.disable_adapter() if scale == 0 else nullcontext():
            during = adapter_flags(model)
            if set(during) != set(before) or any(value != (scale == 0) for value in during.values()):
                raise RuntimeError('Actual LoRA disable flags do not match the requested arm')
            evidence['adapter_flags_during'] = during
            yield
    finally:
        after = adapter_flags(model)
        evidence['adapter_flags_after'] = after
        if after != before:
            raise RuntimeError('LoRA disable flags were not restored after the request')


def clear_request_cache(model):
    """Discard only transient generation caches; never change weights or math."""
    cleared = []
    for name, module in model.named_modules():
        for attribute in ('_cache', '_past_key_values', '_previous_max_cache_length'):
            if attribute in module.__dict__:
                del module.__dict__[attribute]
                cleared.append(name + ':' + attribute)
    return cleared


def tokenize_full(tokenizer, messages, cap):
    ids = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True,
                                        enable_thinking=False)
    check(isinstance(ids, list) and bool(ids) and all(type(value) is int for value in ids),
          'invalid_template', 'Tokenizer did not return complete text token IDs')
    check(len(ids) + cap <= CONTEXT_TOKENS, 'context_length_exceeded',
          'Full prompt plus requested output exceeds 32768 tokens; no input was truncated')
    return ids


def load_trusted_speed(source):
    if sha_file(source) != SPEED_SHA:
        raise RuntimeError('Trusted speed reference source changed')
    spec = importlib.util.spec_from_file_location('_controlled31b_trusted_speed', source)
    speed = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(speed)
    return speed


def initialize(report, work):
    root = Path(__file__).resolve().parent.parent
    sources = json.loads((root / 'SOURCE_SHA256.json').read_text())
    for name, expected in sources.items():
        if Path(name).name != name or sha_file(root / 'code' / name) != expected:
            raise RuntimeError('Controlled worker source binding mismatch')
    speed = load_trusted_speed(Path(__file__).with_name('speed_reference.py'))
    reference, config, binding, manifest_sha = speed.preflight()
    packages = Path(sys.prefix) / 'lib/python3.12/site-packages'
    for name, expected in LORA_SOURCE_SHA.items():
        if sha_file(speed.real_file(packages / name)) != expected:
            raise RuntimeError('Inspected LoRA runtime source changed')
    if config.get('device_map') != 'layer_split' or config.get('layer_split') != 28:
        raise RuntimeError('The original two-GPU layer split 28 is required')
    report.update(stage='loading_model', checkpoint=str(speed.CHECKPOINT),
                  checkpoint_manifest_sha256=manifest_sha, adapter_sha256=speed.ADAPTER_SHA)
    atomic(work, report)
    sys.path.insert(0, str(speed.LEGACY))
    from counseling_pipeline.stage1_preparation import load_model
    model, tokenizer = load_model(config)
    import torch
    from unsloth import FastModel
    from peft.utils.save_and_load import load_peft_weights, set_peft_model_state_dict
    set_peft_model_state_dict(model, load_peft_weights(str(speed.CHECKPOINT), device='cpu'), adapter_name='default')
    names = [name for name, value in model.named_parameters() if value.requires_grad]
    speed.require(sum(value.numel() for value in reference.parameters(model)) == 61214720,
                  'Unexpected adapter parameter count')
    speed.require(reference.parameter_sha(model) == speed.ADAPTER_SHA, 'Loaded adapter digest mismatch')
    metadata = speed.parameter_metadata(model)
    FastModel.for_inference(model)
    model.eval(); model.requires_grad_(False)
    speed.require(torch.cuda.device_count() == 2 and not torch.distributed.is_initialized(), 'Expected two local GPUs')
    flags = adapter_flags(model)
    speed.require(not any(flags.values()), 'Adapter unexpectedly disabled at load')
    tokenizer_files = {name: entry for name, entry in binding['model_files'].items()
                       if 'token' in name.lower() or 'vocab' in name.lower() or 'merges' in name.lower()
                       or 'chat_template' in name.lower()}
    identity = {'model': 'malssi-gemma4-31b-controlled', 'remote_root': str(root),
                'model_aliases': [BASE_ALIAS, TRAINED_ALIAS], 'base_model_path': config['model_path'],
                'base_files': binding['model_files'], 'tokenizer_files': tokenizer_files,
                'checkpoint': str(speed.CHECKPOINT), 'checkpoint_manifest_sha256': manifest_sha,
                'adapter_path': str(speed.CHECKPOINT / 'adapter_model.safetensors'),
                'adapter_file_sha256': sha_file(speed.CHECKPOINT / 'adapter_model.safetensors'),
                'adapter_digest_kind': 'named_LoRA_float32_tensor_bytes',
                'base_manifest_sha256': canonical_sha(binding['model_files']),
                'tokenizer_manifest_sha256': canonical_sha(tokenizer_files),
                'checkpoint_files': json.loads((speed.CHECKPOINT / 'CHECKPOINT.json').read_text())['files'],
                'adapter_parameters_sha256': speed.ADAPTER_SHA, 'adapter_tensor_digest': speed.ADAPTER_SHA,
                'adapter_module_count': len(flags), 'inspected_lora_runtime_source_sha256': LORA_SOURCE_SHA,
                'base_identity_kind': 'sha256_canonical_checkpoint_bound_model_files_manifest',
                'base_loading': 'existing checkpoint-bound NF4 loader, layer_split=28',
                'loader_config': config, 'source_sha256': sources, 'trusted_speed_sha256': SPEED_SHA,
                'versions': binding['versions'], 'optimization': {'mode': 'original_baseline', 'new_patches': False},
                'actual_weight_identity': {'adapter_parameters_sha256': reference.parameter_sha(model),
                  'base_files_verified_by_preflight': True, 'parameter_metadata_sha256': canonical_sha(metadata)}}
    state = {'model': model, 'tokenizer': tokenizer, 'torch': torch, 'speed': speed, 'reference': reference,
             'binding': binding, 'manifest_sha': manifest_sha, 'names': names,
             'parameter_metadata': metadata, 'identity': identity, 'request_control_root': root}
    report['stage'] = 'qualifying_adapter_disable'; atomic(work, report)
    identity['adapter_disable_qualification'] = qualify_adapter_disable(state)
    return state



@contextmanager
def zero_adapter_scaling(model, evidence):
    layers = [(name, module) for name, module in model.named_modules()
              if hasattr(module, 'lora_A') and hasattr(module, 'lora_B')]
    before = []
    try:
        for name, module in layers:
            if not isinstance(module.scaling, dict) or 'default' not in module.scaling:
                raise RuntimeError('Missing default adapter scale')
            before.append((name, module, dict(module.scaling)))
            module.scaling['default'] = 0.0
        evidence['zero_scaled_layer_count'] = len(before)
        yield
    finally:
        for name, module, scaling in before:
            module.scaling.clear(); module.scaling.update(scaling)
        evidence['scaling_restored'] = all(module.scaling == scaling for _, module, scaling in before)
        if not evidence['scaling_restored']:
            raise RuntimeError('Adapter scale metadata was not restored')


def qualify_adapter_disable(state):
    """Compare the actual prefill AND decode paths, before real assignments.

    A six-token synthetic startup probe is separate from every evaluation
    denominator. Explicit zero LoRA scaling is a metadata-only control, restored
    in a finally block; all adapter parameter bytes are checked afterwards.
    """
    model, tokenizer, torch = state['model'], state['tokenizer'], state['torch']
    ids = tokenize_full(tokenizer, [{'role': 'user', 'content': '1부터 숫자를 순서대로 쓰세요.'}], 2)
    device = model.get_input_embeddings().weight.device
    runs = {}
    proof = {'scope': 'synthetic_startup_only_not_evaluation', 'max_new_tokens_per_run': 2,
             'comparison': 'PEFT-disabled versus explicit-zero scaling on the same base',
             'rtol': 0.0, 'atol': 1e-5, 'input_ids_sha256': sequence_sha(ids), 'runs': {}}
    try:
        for mode in ('enabled', 'disabled', 'zero_scaling'):
            clear_request_cache(model)
            torch.manual_seed(3407); torch.cuda.manual_seed_all(3407)
            evidence = {}
            context = zero_adapter_scaling(model, evidence) if mode == 'zero_scaling' else nullcontext()
            with context, selected_adapter(model, 0 if mode == 'disabled' else 1, evidence), torch.inference_mode():
                result = model.generate(
                    input_ids=torch.tensor([ids], dtype=torch.long, device=device),
                    attention_mask=torch.ones((1, len(ids)), dtype=torch.long, device=device),
                    max_new_tokens=2, do_sample=False, num_beams=1, use_cache=True,
                    return_dict_in_generate=True, output_scores=True)
            for index in range(2):
                torch.cuda.synchronize(index)
            if len(result.scores) != 2:
                raise RuntimeError('Startup qualification must exercise both prefill and decode')
            scores = [score.detach().float().cpu() for score in result.scores]
            if any(bool(torch.isnan(score).any()) or bool(torch.isposinf(score).any()) for score in scores):
                raise RuntimeError('NaN or positive-infinite qualification logits')
            tokens = result.sequences[0, len(ids):].tolist()
            runs[mode] = scores
            proof['runs'][mode] = {'score_sha256': [hashlib.sha256(score.contiguous().numpy().tobytes()).hexdigest() for score in scores],
                                   'output_ids_sha256': sequence_sha(tokens), 'output_token_ids': tokens,
                                   'actual_tokens': len(tokens), 'adapter_flags_proof': evidence}
            result = None
        differences, equal = [], True
        for disabled, zero in zip(runs['disabled'], runs['zero_scaling']):
            same_negative_infinity = bool(torch.equal(torch.isneginf(disabled), torch.isneginf(zero)))
            finite = torch.isfinite(disabled) & torch.isfinite(zero)
            if not bool(finite.any()):
                raise RuntimeError('No finite qualification logits')
            differences.append(float((disabled[finite] - zero[finite]).abs().max().item()))
            equal = equal and same_negative_infinity and bool(torch.allclose(disabled[finite], zero[finite], rtol=0, atol=1e-5))
        finite = torch.isfinite(runs['enabled'][0]) & torch.isfinite(runs['disabled'][0])
        if not bool(finite.any()):
            raise RuntimeError('No comparable finite enabled logits')
        enabled_difference = float((runs['enabled'][0][finite] - runs['disabled'][0][finite]).abs().max().item())
        proof['nonfinite_policy'] = 'Reject NaN/+inf; disabled/zero -inf masks must match; compare finite positions only'
        proof.update(disabled_zero_max_absolute_logit_difference=differences,
                     enabled_disabled_first_step_max_absolute_logit_difference=enabled_difference,
                     actual_generated_tokens=sum(row['actual_tokens'] for row in proof['runs'].values()),
                     disabled_matches_zero_scaling=equal, enabled_has_measurable_effect=enabled_difference > 1e-5)
        if not equal or enabled_difference <= 1e-5:
            raise RequestError('adapter_disable_qualification_failed',
                               'Actual generation does not prove controlled adapter disablement', proof)
        proof['status'] = 'passed'
        return proof
    finally:
        clear_request_cache(model)
        verify_unchanged(state)
        if any(adapter_flags(model).values()):
            raise RuntimeError('Adapter state was not restored after startup qualification')


def verify_unchanged(state, full=False):
    speed, model = state['speed'], state['model']
    if speed.parameter_metadata(model) != state['parameter_metadata']:
        raise RuntimeError('Model parameter metadata changed')
    if speed.adapter_sha_by_names(model, state['names']) != speed.ADAPTER_SHA:
        raise RuntimeError('Adapter parameter bytes changed')
    if full:
        speed.require(speed.sha(speed.real_file(speed.CHECKPOINT / 'CHECKPOINT.json')) == state['manifest_sha'],
                      'Checkpoint manifest changed')
        state['reference'].verify_checkpoint(speed.CHECKPOINT, state['binding'])
        for name, expected in state['binding']['code_sha256'].items():
            speed.require(speed.sha(speed.real_file(name)) == expected, 'Original checkpoint-bound source changed')


def generate(state, payload, request_control=None):
    parsed = parse_payload(payload)
    deadline = Deadline(cancellation=request_control.cancelled if request_control else None)
    started = time.perf_counter()
    model, tokenizer, torch, speed = [state[key] for key in ('model', 'tokenizer', 'torch', 'speed')]
    ids = tokenize_full(tokenizer, parsed['messages'], parsed['max_tokens'])
    verify_unchanged(state)
    evidence = {'model': parsed['model'], 'lora_scale': parsed['scale'], 'request_seed': 3407,
                'temperature': 0, 'do_sample': False, 'top_p': 1, 'requested_max_tokens': parsed['max_tokens'],
                'input_tokens': len(ids), 'input_ids_sha256': sequence_sha(ids),
                'input_truncated': False, 'fresh_input_cache_per_request': True,
                'cache_entries_cleared_before': clear_request_cache(model),
                'adapter_digest_before': speed.ADAPTER_SHA}
    device = model.get_input_embeddings().weight.device
    inputs = {'input_ids': torch.tensor([ids], dtype=torch.long, device=device),
              'attention_mask': torch.ones((1, len(ids)), dtype=torch.long, device=device)}
    from transformers import StoppingCriteriaList

    def synchronize():
        for index in range(2):
            torch.cuda.synchronize(index)

    class CaptureTimer(speed.FirstTokenTimer):
        def __init__(self):
            super().__init__(len(ids), synchronize)
            self.tokens = []
        def put(self, value):
            was_prompt = self.prompt_seen
            super().put(value)
            if was_prompt:
                self.tokens.extend(value.reshape(-1).tolist())

    streamer = CaptureTimer()
    torch.manual_seed(3407); torch.cuda.manual_seed_all(3407)
    synchronize()
    generation_started = time.perf_counter()
    output, tokens = None, []
    try:
        if deadline(None, None) and deadline.cancelled:
            raise RequestError('request_cancelled', 'The active request was cooperatively cancelled', evidence)
        with selected_adapter(model, parsed['scale'], evidence), torch.inference_mode():
            output = model.generate(**inputs, max_new_tokens=parsed['max_tokens'], do_sample=False,
                                    num_beams=1, use_cache=True, streamer=streamer,
                                    stopping_criteria=StoppingCriteriaList([deadline]),
                                    return_dict_in_generate=False, output_scores=False)
        synchronize()
        if deadline.cancelled:
            raise RequestError('request_cancelled', 'The active request was cooperatively cancelled', evidence)
        speed.require(output.ndim == 2 and output.shape[0] == 1, 'Unexpected output shape')
        tokens = output[0, len(ids):].tolist()
        speed.require(tokens == streamer.tokens and 0 < len(tokens) <= parsed['max_tokens']
                      and streamer.ended, 'Incomplete generated-token evidence')
        content = tokenizer.decode(tokens, skip_special_tokens=True)
        evidence.update(output_tokens=len(tokens), output_ids_sha256=sequence_sha(tokens),
                        output_token_ids=tokens, total_seconds=time.perf_counter() - started,
                        generation_seconds=time.perf_counter() - generation_started,
                        deadline_expired=deadline.expired)
        eos = model.generation_config.eos_token_id
        eos = [eos] if type(eos) is int else eos or []
        finish = 'stop' if tokens[-1] in eos else 'length' if len(tokens) == parsed['max_tokens'] else 'stop'
        evidence['finish_reason'] = finish
        if deadline.expired:
            evidence.update(partial_text=content, finish_reason='timeout')
            raise RequestError('request_timeout', 'Generation reached the 900-second request deadline', evidence)
        response = {'id': 'chatcmpl-' + uuid.uuid4().hex, 'object': 'chat.completion', 'created': int(time.time()),
                    'model': parsed['model'], 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': content},
                                                         'finish_reason': finish}],
                    'usage': {'prompt_tokens': len(ids), 'completion_tokens': len(tokens), 'total_tokens': len(ids) + len(tokens)},
                    'evidence': evidence}
        return response, evidence
    except BaseException as exc:
        partial = tokens or streamer.tokens
        evidence.update(output_tokens=len(partial), output_token_ids=partial,
                        output_ids_sha256=sequence_sha(partial),
                        partial_text=tokenizer.decode(partial, skip_special_tokens=True),
                        total_seconds=time.perf_counter() - started)
        if isinstance(exc, RequestError):
            exc.evidence = evidence
            raise
        # Preserve the exact partial response in the private JSONL transport.
        error = RequestError('generation_failed', 'Generation failed; partial output is retained in evidence', evidence)
        error.evidence['exception_type'] = type(exc).__name__
        raise error from exc
    finally:
        output = inputs = None
        evidence['request_cancelled'] = deadline.cancelled
        evidence['cache_entries_cleared_after'] = clear_request_cache(model)
        verify_unchanged(state)
        evidence['adapter_digest_after'] = speed.ADAPTER_SHA


def serve(state, reader, emit, report, work):
    while True:
        line = reader.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        durable_input(work, line)
        request_id, measured = None, {'ordinal': len(report['requests']) + 1}
        try:
            check(len(line.encode('utf-8')) <= MAX_LINE_BYTES and line.endswith('\n'),
                  'invalid_envelope', 'Request line is oversized or incomplete')
            try:
                envelope = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON value')))
            except (ValueError, json.JSONDecodeError):
                raise RequestError('invalid_json', 'Request is not valid JSON') from None
            check(isinstance(envelope, dict) and set(envelope) == {'id', 'payload'},
                  'invalid_envelope', 'Each request requires id and payload')
            request_id = envelope['id']
            check(type(request_id) in (str, int), 'invalid_envelope', 'id must be a string or integer')
            measured['payload_sha256'] = canonical_sha(envelope['payload'])
            control = None
            if state.get('request_control_root'):
                from gpu31b_request_control import control_for_request
                control = control_for_request(state['request_control_root'], request_id)
            if control:
                response, evidence = generate(state, envelope['payload'], request_control=control)
            else:
                response, evidence = generate(state, envelope['payload'])
            measured.update(status='passed', **evidence)
            emit({'id': request_id, 'response': response})
        except RequestError as exc:
            measured.update(status='rejected', code=exc.code, **exc.evidence)
            from gpu31b_request_control import recovery_receipt
            emit({'id': request_id, 'error': {'type': 'timeout_error' if exc.code == 'request_timeout' else 'request_error',
                                             'code': exc.code, 'message': exc.message}, 'evidence': measured,
                  **({'recovery': recovery_receipt(request_id, exc.evidence)} if exc.code in ('request_timeout', 'request_cancelled') else {})})
            if exc.code == 'invalid_envelope' and not line.endswith('\n'):
                raise
        finally:
            # Full raw responses are emitted to the parent; this worker report
            # holds hashes/status only and does not duplicate private transcripts.
            excluded = {'partial_text', 'output_token_ids', 'adapter_flags_before', 'adapter_flags_during', 'adapter_flags_after'}
            report['requests'].append({key: value for key, value in measured.items() if key not in excluded})
            atomic(work, report)


def main():
    work = Path.cwd()
    if work != work.resolve() or (work / 'WORKER_RESULT.json').exists():
        raise RuntimeError('Use a fresh canonical worker work directory')
    transport = os.fdopen(os.dup(sys.stdout.fileno()), 'w', buffering=1, encoding='utf-8')
    sys.stdout.flush(); os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

    def emit(value):
        return durable_emit(work, transport, value, report)

    report = {'schema': 'controlled31b-paired-worker-v1', 'status': 'running', 'stage': 'preflight',
              'pid': os.getpid(), 'started_at': time.time(), 'requests': [],
              'transcripts_saved_by_parent': True, 'transcripts_saved_durably_by_worker': True,
              'transport_status': 'connected', 'optimization': 'original_baseline'}
    code = 0
    try:
        atomic(work, report)
        state = initialize(report, work)
        report.update(stage='ready', status='ready', identity=state['identity'])
        atomic(work, report)
        emit({'event': 'ready', 'pid': os.getpid(), **state['identity'],
              'capabilities': {'max_context_tokens': CONTEXT_TOKENS, 'max_output_tokens': OUTPUT_TOKENS,
                               'request_timeout_seconds': REQUEST_SECONDS, 'sampling': False, 'seed': 3407,
                               'enable_thinking': False, 'truncation': False, 'stream': False,
                               'response_format': False, 'transport_profile': 'prompt_only_unconstrained'}})
        serve(state, sys.stdin, emit, report, work)
        verify_unchanged(state, full=True)
        report.update(status='passed', stage='completed', adapter_unchanged=True, checkpoint_unchanged=True)
        emit({'event': 'closed', 'status': 'passed', 'requests': len(report['requests']), 'adapter_unchanged': True})
    except BaseException as exc:
        code = 1
        report.update(status='failed', error_type=type(exc).__name__)
        if isinstance(exc, RequestError):
            report.update(error_code=exc.code, error_evidence=exc.evidence)
        emit({'event': 'failed', 'stage': report['stage'], 'error_type': type(exc).__name__})
    finally:
        report['finished_at'] = time.time(); atomic(work, report)
        try:
            transport.close()
        except (BrokenPipeError, OSError) as exc:
            report.update(transport_status='failed', transport_close_error_type=type(exc).__name__)
            atomic(work, report)
    raise SystemExit(code)


if __name__ == '__main__':
    main()
