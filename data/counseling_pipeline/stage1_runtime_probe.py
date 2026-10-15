"""Precision-matched, non-updating qualification of the pinned training path."""
import gc
import hashlib
import importlib
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


def qualify(model, tokenizer, raw_rows, lengths, bindings, report_path):
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
        check('gpu_pin', torch.cuda.device_count() == 1 and str(torch.cuda.get_device_properties(0).uuid).removeprefix('GPU-') == os.environ['CUDA_VISIBLE_DEVICES'].removeprefix('GPU-'), {'uuid': os.environ['CUDA_VISIBLE_DEVICES']})
        selected = [max((r for r in raw_rows if lengths[r['id']]['sequence_length'] <= cap), key=lambda r: lengths[r['id']]['sequence_length']) for cap in (256, 512)]
        encoded = [encode_example(r, tokenizer, 4096) for r in selected]
        batch = {k: torch.tensor(v, device='cuda', dtype=torch.long) for k, v in collate_examples(encoded, tokenizer.pad_token_id, 512).items()}
        labels = batch['labels']; idx = (labels != -100).nonzero(); target = labels[idx[:, 0], idx[:, 1]]
        check('token_contract', bool((idx[:, 1] > 0).all()) and sum(r['target_length'] for r in encoded) == len(target),
              {'source_ids': [r['id'] for r in selected], 'target_counts': [r['target_length'] for r in encoded], 'count': len(target), 'labels_shifted_once_inside_model': True})
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
            trainable = [p for p in model.parameters() if p.requires_grad]
            require(all(p.grad is not None and bool(torch.isfinite(p.grad).all()) for p in trainable), 'Missing/nonfinite upstream LoRA gradient')
        finally:
            handle.remove()
        require(len(captured) == 1 and captured[0].grad is not None, 'Missing actual hidden gradient')
        hidden = captured[0].detach().clone(); actual_grad = captured[0].grad.detach().clone()
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
        masks = {'all': torch.ones(len(target), dtype=torch.bool, device='cuda'),
                 'first': torch.tensor([(int(i), int(j)) in first_positions for i, j in idx], device='cuda'),
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
              'scope': 'Gradient at final hidden states, not every LoRA tensor; upstream backward finite checked separately.'})
        del batch, labels, target, hidden, actual_grad, reference_grad; gc.collect(); torch.cuda.empty_cache()
        model.eval(); FastModel.for_inference(model)
        synthetic = {'messages': [{'role': 'user', 'content': '오늘은 여기서 마칠게요. 짧은 인사 한 문장으로 답해주세요.'}, {'role': 'assistant', 'content': '검사용 목표는 입력에 포함하지 않습니다.'}], 'loss_message_mask': [0, 1]}
        generation = []
        for name, row, reserve in [('synthetic', synthetic, 64), ('source', selected[0], 128)]:
            prepared = prepare_generation(row, tokenizer, max_new_tokens=reserve, context_budget=4096)
            explicit = deterministic_generation_config(max_new_tokens=reserve)
            resolved, unused = model._prepare_generation_config(None, **explicit)
            require(not unused, 'Unexpected generation profile keys')
            effective = resolved.to_dict()
            ids = torch.tensor([prepared['input_ids']], device='cuda')
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
        validate_report(report, expected_bindings=bindings, required_checks=REQUIRED_CHECKS, mode='preparation', expected_check_contracts={'fused_loss': 'bf16_linear_fp32_softcap_v1', 'fused_gradient': 'hidden_gradient_bf16_v1'})
        return report
    except Exception as error:
        report.update(status='failed', error_type=type(error).__name__, error=str(error))
        raise
    finally:
        report['finished_unix'] = time.time(); write_json(report_path, report)
