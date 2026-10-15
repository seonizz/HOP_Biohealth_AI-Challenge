"""Precision-matched, non-updating qualification of the pinned training path."""
import gc
import hashlib
import importlib
import math
import os
import time

from .stage1_preparation import require, write_json, REQUIRED_CHECKS
from .gemma4_token_validation import collate_examples, encode_example
from .gemma4_generation_validation import prepare_generation, inspect_generation, deterministic_generation_config
from .stage1_readiness import validate_report


def adapter_hash(model):
    import torch
    h = hashlib.sha256()
    for name, value in model.named_parameters():
        if value.requires_grad:
            h.update(name.encode()); h.update(value.detach().cpu().contiguous().view(torch.uint8).numpy().tobytes())
    return h.hexdigest()


def device_evidence(model, cuda, visible_devices, expected_uuids):
    """Fail closed unless both pinned GPUs actually hold trainable model tensors."""
    expected = tuple(expected_uuids)
    visible = tuple(value.strip() for value in visible_devices.split(','))
    require(len(expected) == 2 and len(set(expected)) == 2 and visible == expected,
            'Qualification requires the two pinned GPU UUIDs in configured order')
    require(cuda.device_count() == 2, 'Qualification requires exactly two visible GPUs')
    actual = [str(cuda.get_device_properties(i).uuid).removeprefix('GPU-') for i in range(2)]
    require(actual == [value.removeprefix('GPU-') for value in expected], 'Physical GPU pin mismatch')
    placement = {}
    for _, parameter in model.named_parameters():
        item = placement.setdefault(str(parameter.device), {'tensors': 0, 'elements': 0, 'trainable_tensors': 0})
        item['tensors'] += 1
        item['elements'] += parameter.numel()
        item['trainable_tensors'] += int(parameter.requires_grad)
    require(set(placement) == {'cuda:0', 'cuda:1'} and
            all(item['trainable_tensors'] > 0 for item in placement.values()),
            'Both pinned GPUs must hold model parameters and trainable adapters without offload')
    input_device = model.get_input_embeddings().weight.device
    head_device = model.get_base_model().lm_head.weight.device
    require(str(input_device) in placement and str(head_device) in placement, 'Invalid embedding/head placement')
    return {'requested_uuids': list(expected), 'actual_uuids': ['GPU-' + value for value in actual],
            'placement': placement, 'input_device': str(input_device), 'head_device': str(head_device)}


def upstream_gradient_evidence(model, torch):
    """Record numerical backward evidence for every trainable tensor on both GPUs."""
    results = {}
    for name, parameter in model.named_parameters():
        if not parameter.requires_grad:
            continue
        require(parameter.grad is not None, 'Missing upstream LoRA gradient: ' + name)
        grad = parameter.grad.detach()
        require(bool(torch.isfinite(grad).all()), 'Nonfinite upstream LoRA gradient: ' + name)
        item = results.setdefault(str(parameter.device), {'tensors': 0, 'elements': 0,
                                                        'sum_squares': 0.0, 'maximum_absolute': 0.0,
                                                        'all_finite': True})
        item['tensors'] += 1
        item['elements'] += grad.numel()
        item['sum_squares'] += float(grad.double().square().sum())
        item['maximum_absolute'] = max(item['maximum_absolute'], float(grad.abs().max()))
    require(set(results) == {'cuda:0', 'cuda:1'}, 'Backward did not cover both GPUs')
    for item in results.values():
        item['l2_norm'] = item.pop('sum_squares') ** .5
    return results


def equivalence_metrics(reference_squared, observed_squared, error_squared, dot):
    """Use strict relative L2/cosine bounds; only two exact zeros bypass cosine."""
    norm, observed_norm, error = (math.sqrt(value) for value in (reference_squared, observed_squared, error_squared))
    both_zero = norm == 0 and observed_norm == 0
    relative = error / norm if norm > 0 else error / 1e-12
    cosine = (1.0 if both_zero else max(-1.0, min(1.0, dot / (norm * observed_norm)))
              if norm > 0 and observed_norm > 0 else 0.0)
    return {'reference_norm': norm, 'observed_norm': observed_norm, 'relative_l2_error': relative,
            'cosine': cosine, 'both_exactly_zero': both_zero,
            'passed': both_zero or norm > 0 and relative <= .02 and cosine >= .999}


def tensor_equivalence(reference, observed):
    """Compare on CPU in bounded blocks, including legitimate all-zero gradients."""
    import torch
    require(reference.shape == observed.shape and reference.numel() > 0, 'Tiled comparison shape mismatch')
    reference = reference.detach().cpu().reshape(-1)
    observed = observed.detach().cpu().reshape(-1)
    totals = [0.0, 0.0, 0.0, 0.0]
    finite = True
    for start in range(0, reference.numel(), 1 << 20):
        left = reference[start:start + (1 << 20)].double()
        right = observed[start:start + (1 << 20)].double()
        if not bool(torch.isfinite(left).all() and torch.isfinite(right).all()):
            finite = False
            break
        for index, value in enumerate((left.square().sum(), right.square().sum(),
                                       (right - left).square().sum(), (right * left).sum())):
            totals[index] += float(value)
    result = {'elements': reference.numel(), 'maximum_relative_l2_error': .02,
              'minimum_cosine': .999, 'all_finite': finite, 'passed': False}
    if not finite:
        return result
    result.update(equivalence_metrics(*totals))
    return result


def mlp_forward_backward(module, forward, cpu_input, cpu_output_gradient):
    """Retain only CPU evidence between the untiled and tiled backward passes."""
    import torch
    trainable = {name: parameter for name, parameter in module.named_parameters() if parameter.requires_grad}
    require(trainable and all('lora_' in name for name in trainable), 'Unexpected MLP trainable inventory')
    devices = {parameter.device for parameter in module.parameters()}
    require(len(devices) == 1, 'An MLP must reside on one device')
    module.zero_grad(set_to_none=True)
    inputs = output = None
    try:
        inputs = cpu_input.to(next(iter(devices))).detach().requires_grad_(True)
        output = forward(inputs)
        require(isinstance(output, torch.Tensor) and output.shape == inputs.shape, 'Unexpected MLP output')
        evidence = {'output': output.detach().cpu().clone()}
        output.backward(cpu_output_gradient.to(output.device))
        require(inputs.grad is not None, 'Missing MLP input gradient')
        require(all(parameter.grad is not None for parameter in trainable.values()), 'Missing MLP LoRA gradient')
        evidence['hidden_gradient'] = inputs.grad.detach().cpu().clone()
        evidence['lora_gradients'] = {name: parameter.grad.detach().cpu().clone()
                                    for name, parameter in trainable.items()}
        return evidence
    finally:
        module.zero_grad(set_to_none=True)
        del inputs, output
        gc.collect()
        torch.cuda.empty_cache()


def tiled_mlp_equivalence(model):
    """Exercise two real tiles on one pinned language MLP per GPU, without updates."""
    import torch
    candidates = [(name, module) for name, module in model.named_modules()
                  if 'language_model.layers.' in name and name.endswith('.mlp')
                  and getattr(module.forward, '__name__', '') == 'tiled_forward_arctic_size']
    require(len(candidates) == 60, 'Tiled qualification requires all 60 language MLPs to be patched')
    selected = {}
    for name, module in candidates:
        device = str(module.gate_proj.weight.device)
        selected.setdefault(device, (name, module))
    require(set(selected) == {'cuda:0', 'cuda:1'}, 'Tiled qualification must exercise both GPUs')
    before = adapter_hash(model)
    results = []
    generator = torch.Generator(device='cpu').manual_seed(3407)
    shape = (1, 10752, 5376)
    cpu_input = torch.randn(shape, dtype=torch.bfloat16, generator=generator)
    cpu_output_gradient = torch.randn(shape, dtype=torch.bfloat16, generator=generator) / math.sqrt(math.prod(shape))
    try:
        for device, (name, module) in sorted(selected.items()):
            original = module._unsloth_forward
            require(callable(original) and getattr(original, '__self__', None) is None,
                    'Expected the installed unbound original MLP forward')
            require(getattr(module.forward, '__module__', '') == 'unsloth_zoo.tiled_mlp'
                    and module.gate_proj.in_features == shape[-1], 'Unexpected tiled implementation or hidden size')
            print({'event': 'tiled_mlp_reference_start', 'module': name, 'device': device, 'shape': list(shape)}, flush=True)
            reference = mlp_forward_backward(module, lambda inputs: original(module, inputs),
                                             cpu_input, cpu_output_gradient)
            calls = []
            def traced_forward(instance, inputs):
                calls.append({'shape': list(inputs.shape), 'grad_enabled': torch.is_grad_enabled()})
                return original(instance, inputs)
            module._unsloth_forward = traced_forward
            try:
                print({'event': 'tiled_mlp_comparison_start', 'module': name, 'device': device}, flush=True)
                observed = mlp_forward_backward(module, module.forward, cpu_input, cpu_output_gradient)
            finally:
                module._unsloth_forward = original
            require(set(reference['lora_gradients']) == set(observed['lora_gradients']), 'MLP LoRA inventory changed')
            metrics = {field: tensor_equivalence(reference[field], observed[field])
                       for field in ('output', 'hidden_gradient')}
            metrics['lora_gradients'] = {key: tensor_equivalence(value, observed['lora_gradients'][key])
                                         for key, value in reference['lora_gradients'].items()}
            expected_calls = ([{'shape': [1, 5376, 5376], 'grad_enabled': False}] * 2
                              + [{'shape': [1, 5376, 5376], 'grad_enabled': True}] * 2)
            passed = (calls == expected_calls and metrics['output']['passed'] and metrics['hidden_gradient']['passed']
                      and all(item['passed'] for item in metrics['lora_gradients'].values()))
            results.append({'module': name, 'device': device, 'input_shape': list(shape),
                            'observed_tile_calls': calls, 'expected_tiles': 2, 'metrics': metrics, 'passed': passed})
            print({'event': 'tiled_mlp_module_result', 'module': name, 'device': device, 'passed': passed}, flush=True)
            del reference, observed
            gc.collect(); torch.cuda.empty_cache()
    finally:
        model.zero_grad(set_to_none=True)
    after = adapter_hash(model)
    return {'criterion': 'tiled_mlp_bf16_v1', 'modules': results, 'patched_language_mlp_count': len(candidates),
            'optimizer_steps': 0, 'adapter_hash_before': before, 'adapter_hash_after': after,
            'weights_unchanged': before == after, 'synthetic_inputs': True,
            'scope': 'Two sequence tiles; MLP output, hidden gradient, and every MLP LoRA gradient; no attention truncation.',
            'passed': before == after and len(results) == 2 and all(item['passed'] for item in results)}


def qualify(model, tokenizer, raw_rows, lengths, bindings, report_path, *, max_length=32768):
    import torch
    from unsloth import FastModel
    report = {'schema_version': 'malssi.stage1-readiness.v1', 'mode': 'preparation', 'status': 'running',
              'optimizer_steps': 0, 'bindings': bindings, 'checks': [], 'started_unix': time.time(),
              'prior_fp32_gate_waived': False, 'scope': 'New BF16-head / FP32-softcap criterion; stage1 only; no optimizer or HOP approval.'}
    def check(name, passed, evidence):
        report['checks'].append({'name': name, 'passed': bool(passed), 'evidence': evidence})
        write_json(report_path, report)
        print({'event': name, 'passed': passed}, flush=True)
        require(passed, 'Qualification failed: ' + name)
    initial = adapter_hash(model)
    try:
        from .stage1_preparation import GPU_UUIDS
        require(type(max_length) is int and max_length >= 512, 'Invalid qualification context budget')
        devices = device_evidence(model, torch.cuda, os.environ['CUDA_VISIBLE_DEVICES'], GPU_UUIDS)
        check('gpu_pin', True, devices)
        input_device = model.get_input_embeddings().weight.device
        head_device = model.get_base_model().lm_head.weight.device
        selected = [max((r for r in raw_rows if lengths[r['id']]['sequence_length'] <= cap), key=lambda r: lengths[r['id']]['sequence_length']) for cap in (256, 512)]
        encoded = [encode_example(r, tokenizer, max_length) for r in selected]
        batch = {k: torch.tensor(v, device=head_device if k == 'labels' else input_device, dtype=torch.long)
                 for k, v in collate_examples(encoded, tokenizer.pad_token_id, 512).items()}
        labels = batch['labels']; idx = (labels != -100).nonzero(); target = labels[idx[:, 0], idx[:, 1]]
        check('token_contract', bool((idx[:, 1] > 0).all()) and sum(r['target_length'] for r in encoded) == len(target),
              {'source_ids': [r['id'] for r in selected], 'target_counts': [r['target_length'] for r in encoded],
               'sequence_lengths': [r['sequence_length'] for r in encoded], 'context_budget': max_length,
               'maximum_context_capacity_assessed': False, 'count': len(target), 'labels_shifted_once_inside_model': True})
        base = model.get_base_model(); cap = base.config.get_text_config().final_logit_softcapping
        require(cap == 30 and base.lm_head.weight.dtype == torch.bfloat16 and not base.lm_head.weight.requires_grad, 'Unexpected head contract')
        captured = []
        def capture(module, args, out):
            out.last_hidden_state.retain_grad(); captured.append(out.last_hidden_state)
        handle = base.model.register_forward_hook(capture)
        model.train(); os.environ['UNSLOTH_RETURN_LOGITS'] = '0'
        try:
            out = model(**batch, use_cache=False)
            actual_loss = float(out.loss.detach()); out.loss.backward()
            upstream_gradients = upstream_gradient_evidence(model, torch)
        finally:
            handle.remove()
        require(len(captured) == 1 and captured[0].grad is not None, 'Missing actual hidden gradient')
        hidden = captured[0].detach().to(head_device).clone()
        actual_grad = captured[0].grad.detach().to(head_device).clone()
        del out; captured.clear(); model.zero_grad(set_to_none=True); gc.collect(); torch.cuda.empty_cache()
        # Full-shape BF16 GEMM, then select supervised predictors; FP32 softcap is
        # explicit. This does not compare to a different FP32 GEMM or rounded BF16 softcap.
        ref_h = hidden.clone().requires_grad_(True)
        raw = torch.nn.functional.linear(ref_h, base.lm_head.weight, base.lm_head.bias)
        selected_logits = raw[idx[:, 0], idx[:, 1] - 1].float()
        token_ce = torch.nn.functional.cross_entropy(torch.tanh(selected_logits / cap) * cap, target, reduction='none')
        reference_loss = token_ce.mean(); reference = float(reference_loss.detach())
        reference_grad = torch.autograd.grad(reference_loss, ref_h)[0].detach()
        token_values = token_ce.detach().cpu().tolist()
        del ref_h, raw, selected_logits, reference_loss, token_ce; gc.collect(); torch.cuda.empty_cache()
        ce = importlib.import_module('unsloth_zoo.fused_losses.cross_entropy_loss')
        # First, body and end are disjoint; native trailing newline is body.
        first_positions = {(i, r['prefix_length']) for i, r in enumerate(encoded)}
        masks = {'all': torch.ones(len(target), dtype=torch.bool, device=head_device),
                 'first': torch.tensor([(i, j) in first_positions for i, j in idx.cpu().tolist()], device=head_device),
                 'end': target == tokenizer.convert_tokens_to_ids('<turn|>')}
        masks['body'] = ~(masks['first'] | masks['end'])
        comparisons = [{'name': 'actual_model_all', 'actual': actual_loss, 'reference': reference,
                        'atol': 0.002, 'rtol': 0.002, 'passed': abs(actual_loss-reference) <= .002+.002*abs(reference)}]
        gradient_results = []
        def compare_gradient(name, observed):
            delta = observed.float() - reference_grad.float()
            norm = float(reference_grad.float().norm())
            relative = float(delta.norm()) / max(norm, 1e-12)
            cosine = float(torch.nn.functional.cosine_similarity(observed.float().flatten(), reference_grad.float().flatten(), dim=0))
            valid = bool(torch.isfinite(observed).all()) and norm > 0 and relative <= .02 and cosine >= .999
            gradient_results.append({'name': name, 'relative_l2_error': relative, 'maximum_relative_l2_error': .02,
                                     'cosine': cosine, 'minimum_cosine': .999, 'reference_norm': norm, 'passed': valid})
        compare_gradient('actual_model_hidden', actual_grad)
        # Unequal chunk supervision exercises global token denominator, including empty chunks.
        for chunks in (1, 3, 8):
            for name, selector in masks.items():
                masked = torch.full_like(labels, -100); points = idx[selector]
                masked[points[:, 0], points[:, 1]] = labels[points[:, 0], points[:, 1]]
                own_h = hidden.clone().requires_grad_(True)
                value = ce.unsloth_fused_ce_loss(None, own_h, base.lm_head.weight, base.lm_head.bias, masked,
                                                torch_compile=True, n_chunks=chunks, shift_labels=True, logit_softcapping=cap)
                observed = float(value.detach()); expected = sum(v for v, yes in zip(token_values, selector.cpu().tolist()) if yes) / int(selector.sum())
                comparisons.append({'name': name + '_chunks_' + str(chunks), 'actual': observed, 'reference': expected,
                                    'atol': .002, 'rtol': .002, 'passed': abs(observed-expected) <= .002+.002*abs(expected),
                                    'supervised_items': int(selector.sum())})
                if name == 'all':
                    grad = torch.autograd.grad(value, own_h)[0]; compare_gradient('chunks_' + str(chunks), grad); del grad
                del own_h, value, masked; gc.collect(); torch.cuda.empty_cache()
        # Negative control: targets scored at their own, not preceding, hidden state.
        with torch.no_grad():
            wrong_raw = torch.nn.functional.linear(hidden, base.lm_head.weight, base.lm_head.bias)
            wrong = torch.nn.functional.cross_entropy(torch.tanh(wrong_raw[idx[:, 0], idx[:, 1]].float()/cap)*cap, target)
            negative = float(wrong)
        del wrong_raw, wrong
        check('fused_loss', all(c['passed'] for c in comparisons) and abs(negative-reference) > .01 and ce._FUSED_CE_COMPILE_SUPPORTED is True,
              {'criterion': 'bf16_linear_fp32_softcap_v1', 'comparisons': comparisons, 'per_token_reference_ce': token_values,
               'shifted_label_positions': idx.cpu().tolist(), 'wrong_unshifted_ce': negative, 'chunks': [1, 3, 8], 'compiled': ce._FUSED_CE_COMPILE_SUPPORTED})
        check('fused_gradient', all(c['passed'] for c in gradient_results), {'criterion': 'hidden_gradient_bf16_v1', 'results': gradient_results,
              'upstream_gradients_by_device': upstream_gradients, 'comparison_device': str(head_device),
              'scope': 'Gradient at final hidden states, not every LoRA tensor; upstream backward finite checked separately.'})
        del batch, labels, target, hidden, actual_grad, reference_grad; gc.collect(); torch.cuda.empty_cache()
        if any(getattr(module.forward, '__name__', '') == 'tiled_forward_arctic_size'
               for _, module in model.named_modules()):
            tiled_evidence = tiled_mlp_equivalence(model)
            check('tiled_mlp_equivalence', tiled_evidence['passed'], tiled_evidence)
        model.eval(); FastModel.for_inference(model)
        synthetic = {'messages': [{'role': 'user', 'content': '오늘은 여기서 마칠게요. 짧은 인사 한 문장으로 답해주세요.'}, {'role': 'assistant', 'content': '검사용 목표는 입력에 포함하지 않습니다.'}], 'loss_message_mask': [0, 1]}
        generation = []
        for name, row, reserve in [('synthetic', synthetic, 64), ('source', selected[0], 128)]:
            prepared = prepare_generation(row, tokenizer, max_new_tokens=reserve, context_budget=max_length)
            explicit = deterministic_generation_config(max_new_tokens=reserve)
            resolved, unused = model._prepare_generation_config(None, **explicit)
            require(not unused, 'Unexpected generation profile keys')
            effective = resolved.to_dict()
            ids = torch.tensor([prepared['input_ids']], device=input_device)
            seen = []
            def prefill(module, args, kwargs):
                value = kwargs.get('input_ids', args[0] if args else None)
                if not seen and isinstance(value, torch.Tensor): seen.append(value.detach().cpu().tolist()[0])
            hook = model.get_base_model().register_forward_pre_hook(prefill, with_kwargs=True)
            try:
                with torch.inference_mode():
                    output = model.generate(input_ids=ids, attention_mask=torch.ones_like(ids), **explicit)
            finally:
                hook.remove()
            require(seen and seen[0] == prepared['input_ids'], 'Prefill changed')
            inspected = inspect_generation(output[0].cpu().tolist(), prepared, tokenizer, stop_ids=explicit['eos_token_id'],
                        effective_generation_config=effective, no_extra_logits_processors=True, no_extra_stopping_criteria=True)
            generation.append({'case': name, 'prefix_ids': prepared['input_ids'], 'actual_prefill_ids': seen[0],
                               'effective_config': effective, 'inspection': inspected})
            del ids, output; gc.collect(); torch.cuda.empty_cache()
        check('generation_profile', True, {'cases': generation, 'content_quality_assessed': False})
        check('weights_unchanged', initial == adapter_hash(model), {'before': initial, 'after': adapter_hash(model), 'optimizer_steps': 0})
        report['status'] = 'passed'
        contracts = {'fused_loss': 'bf16_linear_fp32_softcap_v1', 'fused_gradient': 'hidden_gradient_bf16_v1'}
        if 'tiled_mlp_equivalence' in REQUIRED_CHECKS:
            contracts['tiled_mlp_equivalence'] = 'tiled_mlp_bf16_v1'
        validate_report(report, expected_bindings=bindings, required_checks=REQUIRED_CHECKS,
                        mode='preparation', expected_check_contracts=contracts)
        return report
    except Exception as error:
        report.update(status='failed', error_type=type(error).__name__, error=str(error))
        raise
    finally:
        report['finished_unix'] = time.time(); write_json(report_path, report)
