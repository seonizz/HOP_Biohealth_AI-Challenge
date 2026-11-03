"""Bounded A/B qualification; never commits benchmark updates to training."""
import argparse
import copy
import inspect
import json
import math
from pathlib import Path
import random
import sys
import statistics
import subprocess
import threading
import time

import reference_train_cards_31b as ref
import cards31b_compute as compute


def sync():
    import torch
    for d in range(2):
        torch.cuda.synchronize(d)


def measure(name, call, tokens):
    import torch
    sync()
    for d in range(2):
        torch.cuda.reset_peak_memory_stats(d)
    samples=[];stop=threading.Event()
    def monitor():
        while not stop.is_set():
            try:
                out=subprocess.check_output(['nvidia-smi','--query-gpu=utilization.gpu,power.draw','--format=csv,noheader,nounits'],text=True,timeout=2)
                rows=[[float(v.strip()) for v in line.split(',')] for line in out.strip().splitlines()]
                if len(rows)==2:samples.append(rows)
            except Exception:pass
            stop.wait(.5)
    thread=threading.Thread(target=monitor,daemon=True);thread.start()
    started = time.monotonic()
    try:
        result = call()
        sync()
        elapsed = time.monotonic() - started
    finally:
        stop.set();thread.join(timeout=3)

    record = {'name': name, 'seconds': elapsed, 'tokens': tokens,
              'tokens_per_second': tokens / elapsed,
              'peak_allocated_mib': [torch.cuda.max_memory_allocated(d)/2**20 for d in range(2)],
              'peak_reserved_mib': [torch.cuda.max_memory_reserved(d)/2**20 for d in range(2)]}
    if samples:
        record['gpu_samples']=len(samples)
        record['gpu_util_mean']=[statistics.mean(s[d][0] for s in samples) for d in range(2)]
        record['both_gpu_util_above_50_percent']=100*sum(all(g[0]>50 for g in s) for s in samples)/len(samples)
    ref.event('measurement', **record)
    return result, record


def comparison(reference, actual):
    errors = [abs(a-b) for a,b in zip(reference, actual)]
    return {'max_abs_error': max(errors), 'mean_abs_error': sum(errors)/len(errors),
            'passed': len(reference) == len(actual) and all(
                math.isfinite(a) and math.isclose(a,b,rel_tol=0.002,abs_tol=0.002)
                for a,b in zip(reference,actual))}


def main(args):
    # Reuse the original full model/data/environment checks before any loading.
    original_mode = args.mode
    args.mode = 'preflight'
    ref.run(args)
    args.mode = original_mode
    code_names=['benchmark_cards31b.py','cards31b_compute.py','cards31b_pipeline.py',
                'reference_train_cards_31b.py','bootstrap.py','boundary.py','test_cards31b_compute.py','cards31b_training_pipeline.py']
    proof={'code_sha256':{n:ref.sha(Path(__file__).with_name(n)) for n in code_names},
           'reference_binding_sha256':ref.sha(args.work/'BINDING.json'),
           'learning_rate':args.lr,'accumulation':args.accumulation}
    ref.atomic(args.work/'START_PROOF.json',proof)
    import torch
    sys.path.insert(0, str(args.legacy_kit))
    from counseling_pipeline.stage1_preparation import load_model
    from role_dataset import IndexedTokens
    config = json.loads((args.legacy_kit/'config/train.json').read_text())
    config.update(max_length=32768, model_path=str(args.model))
    model, _ = load_model(config)
    initial_sha = ref.parameter_sha(model)
    ref.require(initial_sha == 'dd75effaa0fbede54d5a24a302cab6d1520278ed87051f39a174cd934a719e49', 'Fresh initialization changed')
    course = json.loads((args.dataset/'COURSE.json').read_text())
    phase = course['phases'][0]
    datasets = {s:IndexedTokens(args.dataset/p['token_index'],args.dataset/p['token_binary']) for s,p in phase['data'].items()}
    base = model.get_base_model()
    lm = base.model.language_model
    runtime = {'head_dtype': str(base.lm_head.weight.dtype), 'head_device':str(base.lm_head.weight.device),
               'tied_storage':base.lm_head.weight.data_ptr()==model.get_input_embeddings().weight.data_ptr(),
               'modules':{}}
    for name, module in [('model',base.model),('language_model',lm),*[(str(i),lm.layers[i]) for i in [0,27,28,59]]]:
        hook=getattr(module,'_hf_hook',None)
        try:
            source=inspect.getsourcefile(module.forward)
        except TypeError:
            source=repr(module.forward)[:200]
        runtime['modules'][name]={'source':source,
                                 'signature':str(inspect.signature(module.forward)),
                                 'hook':repr(hook), 'hook_flags':{k:str(getattr(hook,k,None)) for k in ['offload','io_same_device','execution_device']}, 'old_forward':repr(getattr(module,'_old_forward',None))[:150]}
    runtime['kv_shared_layers']=getattr(base.config.get_text_config(),'num_kv_shared_layers',0)
    runtime['kv_flags']=[{k:getattr(layer.self_attn,k,None) for k in ['is_kv_shared_layer','store_full_length_kv']} for layer in lm.layers]
    ref.atomic(args.work/'runtime-model.json',runtime)
    import unittest
    import test_cards31b_compute
    test_result=unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromModule(test_cards31b_compute))
    ref.require(test_result.wasSuccessful() and not test_result.skipped,'Compute CPU tests failed or skipped')
    val=datasets['validation']; train=datasets['train']
    sorted_ids=sorted(range(len(val)),key=lambda i:val.entries[i]['sequence_length'])
    regression_ids={'sft_445d0b3ff703d1d2512a538376c6cdf72ccea79ebc54b31b6b84ef5c3a372aa6',
                    'sft_93abde4d60cf34dd2c640ee0dd86ff60c50d8509e07be294325553f92389b7b8'}
    chosen=list(dict.fromkeys([i for i,e in enumerate(val.entries) if e['row_id'] in regression_ids]+
                             [sorted_ids[int((len(val)-1)*q)] for q in [0,.25,.5,.75,.9,1]]+
                             [max(range(len(val)),key=lambda i:val.entries[i]['target_length'])]))
    rows={i:val[i] for i in chosen}; tokens=sum(val.entries[i]['sequence_length'] for i in chosen)
    model.eval()
    report={'execution_proof':proof,'compute_cpu_tests':test_result.testsRun,'initial_adapter_sha256':initial_sha,'scope':'same full-context examples, no truncated input',
            'evaluation':{},'training':{},'suite':[{k:val.entries[i][k] for k in ['row_id','sequence_length','target_length']} for i in chosen]}
    warmup_row=next(rows[i] for i in chosen if val.entries[i]['row_id']=='sft_93abde4d60cf34dd2c640ee0dd86ff60c50d8509e07be294325553f92389b7b8')
    report['evaluation_warmup']=compute.stabilize_evaluation(model,warmup_row)
    ref.require(ref.parameter_sha(model)==initial_sha,'Warmup changed adapter')
    ref.atomic(args.work/'BENCHMARK.json',report)
    with torch.no_grad():
        regression_rows=[rows[i] for i in chosen if val.entries[i]['row_id'] in regression_ids]
        expected=[float(ref.selected_loss(model,row)) for row in regression_rows]
        actual=[float(compute.evaluation_losses(model,[row])[0]) for row in regression_rows]
        report['head_shape_regression']={'reference':expected,'optimized':actual,**comparison(expected,actual)}
        ref.atomic(args.work/'BENCHMARK.json',report)
        ref.require(report['head_shape_regression']['passed'],'Original-shape head regression differs')
        # Isolate backbone identity from compiler-dependent head rounding.
        probe=val[sorted_ids[len(sorted_ids)//2]]
        warm_probe=[float(ref.selected_loss(model,probe)) for _ in range(2)]
        captured=[]
        hook=base.model.register_forward_hook(lambda module,args,out:captured.append(out.last_hidden_state.detach().clone()))
        reference_probe=float(ref.selected_loss(model,probe));hook.remove()
        _,direct,_=compute.backbone_hidden(model,[probe])
        h=captured[0];direct=direct.to(h.device);enc=probe['encoded'];pfx=enc['prefix_length'];length=enc['sequence_length']
        logits=torch.nn.functional.linear(h[0,pfx-1:length-1].to(base.lm_head.weight.device),base.lm_head.weight,base.lm_head.bias)
        targets=torch.tensor(enc['input_ids'][pfx:length],device=logits.device)
        cap=base.config.get_text_config().final_logit_softcapping
        bf16=float(torch.nn.functional.cross_entropy((torch.tanh(logits/cap)*cap).float(),targets))
        fp32=float(torch.nn.functional.cross_entropy(torch.tanh(logits.float()/cap)*cap,targets))
        compiled=float(compute.evaluation_losses(model,[probe],chunk_tokens=256)[0])
        report['head_diagnostic']={'reference_warmup_losses':warm_probe,'backbone_relative_l2':float((h.float()-direct.float()).norm()/h.float().norm()),'backbone_exact':torch.equal(h,direct),'backbone_max_abs':float((h-direct).abs().max()),
                                  'reference_ce':reference_probe,'eager_native_cap_ce':bf16,'eager_fp32_cap_ce':fp32,'compiled_forward_ce':compiled}
        ref.atomic(args.work/'BENCHMARK.json',report)
        ref.require(bool(torch.isfinite(h).all()) and bool(torch.isfinite(direct).all()) and comparison([reference_probe],[compiled])['passed'],'Compiled head CE diagnostic differs')
        del captured,h,direct,logits
        # Include a measured cold control and then warmed repeated A/B runs.
        _,cold=measure('short_control_after_diagnostic',lambda:ref.selected_loss(model,rows[chosen[0]]).item(),val.entries[chosen[0]]['sequence_length'])
        report['cold_control']=cold
        reference,record=measure('reference_eval',lambda:[float(ref.selected_loss(model,rows[i])) for i in chosen],tokens)
        report['evaluation']['reference']={'timing':record,'losses':reference}
        modes=[('forward_full',1,'full'),('target_batch1',1,'target'),('target_batch2',2,'target'),('target_batch4',4,'target')]
        for name,batch_size,head_mode in modes:
            batches=compute.plan_validation_batches(val.entries,16384,batch_size,chosen)
            def call():
                result={}
                for batch in batches:
                    losses=compute.evaluation_losses(model,[rows[i] for i in batch],head_mode=head_mode,chunk_tokens=256).cpu().tolist()
                    result.update(zip(batch,losses))
                return [result[i] for i in chosen]
            try:
                values,timing=measure(name,call,tokens)
                check=comparison(reference,values)
                report['evaluation'][name]={'timing':timing,'losses':values,'comparison':check,
                                            'batches':batches,'speedup':record['seconds']/timing['seconds']}
            except torch.cuda.OutOfMemoryError as e:
                report['evaluation'][name]={'failed':'out_of_memory','message':str(e)[:200]}
                torch.cuda.empty_cache()
            ref.atomic(args.work/'BENCHMARK.json',report)
        # All compared shapes have now run once. Alternate warmed A/B order.
        repeats = {k:[] for k,v in report['evaluation'].items() if k=='reference' or v.get('comparison',{}).get('passed')}
        for round_id in range(2):
            names=list(repeats)
            if round_id: names.reverse()
            for name in names:
                if name=='reference':
                    call=lambda:[float(ref.selected_loss(model,rows[i])) for i in chosen]
                else:
                    batch_size=1 if name=='forward_full' else int(name[-1])
                    head_mode='full' if name=='forward_full' else 'target'
                    batches=compute.plan_validation_batches(val.entries,16384,batch_size,chosen)
                    def call():
                        result={}
                        for batch in batches:
                            result.update(zip(batch,compute.evaluation_losses(model,[rows[i] for i in batch],head_mode=head_mode,chunk_tokens=256).cpu().tolist()))
                        return [result[i] for i in chosen]
                values,timing=measure(name+'_warm_'+str(round_id),call,tokens)
                ref.require(comparison(reference,values)['passed'],'Warmed evaluator changed result')
                repeats[name].append(timing)
        for name,timings in repeats.items():
            report['evaluation'][name]['warm_timings']=timings
            report['evaluation'][name]['median_seconds']=statistics.median(t['seconds'] for t in timings)
        for name in repeats:
            report['evaluation'][name]['warm_speedup']=report['evaluation']['reference']['median_seconds']/report['evaluation'][name]['median_seconds']
        # The explicit stream pipeline is a candidate; reject safely on mismatch.
        try:
            from cards31b_pipeline import evaluation_losses_pipeline
            values,timing=measure('pipeline_cold',lambda:evaluation_losses_pipeline(model,[rows[i] for i in chosen]).cpu().tolist(),tokens)
            check=comparison(reference,values)
            report['pipeline']={'comparison':check,'cold_timing':timing}
            if check['passed']:
                ts=[]
                for j in range(2):
                    values,t=measure('pipeline_warm_'+str(j),lambda:evaluation_losses_pipeline(model,[rows[i] for i in chosen]).cpu().tolist(),tokens)
                    ref.require(comparison(reference,values)['passed'],'Pipeline changed result')
                    ts.append(t)
                report['pipeline'].update(warm_timings=ts,median_seconds=statistics.median(t['seconds'] for t in ts))
        except Exception as e:
            report['pipeline']={'rejected':type(e).__name__,'reason':str(e)[:1000]}
            torch.cuda.empty_cache()
        ref.atomic(args.work/'BENCHMARK.json',report)
        # Validate every completed original baseline row, preserving ID binding.
        old=Path('/home/slim/choieram/model_Training/cards31b_fresh_lora_20261031_r1/training/00_original_warmup-baseline.jsonl')
        prior=[json.loads(x) for x in old.read_text().splitlines()]
        ref.require(all(r['adapter_sha256']==initial_sha for r in prior),'Old evaluator weight binding changed')
        candidates=[(v['median_seconds'],n) for n,v in report['evaluation'].items() if n.startswith('target_batch') and v.get('comparison',{}).get('passed')]
        ref.require(candidates,'No evaluation candidate passed')
        selected=min(candidates)[1]; batch_size=int(selected[-1]);backend='serial';eval_budget=16384
        pipe=report.get('pipeline',{})
        if pipe.get('comparison',{}).get('passed') and pipe.get('median_seconds',float('inf')) < min(candidates)[0]:
            backend='pipeline';batch_size=2;eval_budget=32768
        report['selected_eval_backend']=backend
        report['selected_eval_token_budget']=eval_budget
        by_id={r['row_id']:r for r in prior};ref.require(len(by_id)==len(prior),'Duplicate original validation row'); indices=[i for i,r in enumerate(val.entries) if r['row_id'] in by_id]
        all_ref=[]; all_new=[]; coverage=[];refreshed=0
        compare_started=time.monotonic()
        journal=(args.work/'BASELINE_COMPARE.jsonl').open('x')
        for batch in compute.plan_validation_batches(val.entries,eval_budget,batch_size,indices):
            evaluator=evaluation_losses_pipeline if backend=='pipeline' else compute.evaluation_losses
            values=evaluator(model,[val[i] for i in batch],chunk_tokens=256).cpu().tolist()
            for i,value in zip(batch,values):
                entry=val.entries[i]; oldrow=by_id[entry['row_id']]
                ref.require(oldrow['target_tokens']==entry['target_length'],'Old target count differs')
                expected=oldrow['mean_target_ce'];recheck=None
                if not comparison([expected],[value])['passed']:
                    # Re-run the unchanged original code to distinguish a cold/
                    # different-process BF16 kernel result from candidate drift.
                    original_a=float(ref.selected_loss(model,val[i]))
                    original_b=float(ref.selected_loss(model,val[i]))
                    # Preserve the FIRST candidate value above. A retry can
                    # diagnose a cold transition but cannot replace a failure.
                    repeated=evaluator(model,[val[i]],chunk_tokens=256).cpu().tolist()[0]
                    original_after=float(ref.selected_loss(model,val[i]))
                    recheck={'original_first':original_a,'original_second':original_b,
                             'candidate_repeated':repeated,'original_after':original_after}
                    expected=original_b;refreshed+=1
                all_ref.append(expected);all_new.append(value);coverage.append(entry['row_id'])
                journal.write(json.dumps({'row_id':entry['row_id'],'stored_reference':oldrow['mean_target_ce'],
                    'reference':expected,'optimized':value,'target_tokens':entry['target_length'],
                    'adapter_sha256':initial_sha,'bounded_recheck':recheck})+'\n')
                journal.flush()
                if recheck is not None:
                    ref.require(original_a==original_b==original_after,'Original evaluator did not remain stable')
                    ref.require(comparison([expected],[repeated])['passed'],'Repeated evaluator differs')
                ref.require(comparison([expected],[value])['passed'],'Fresh original evaluator differs: '+entry['row_id'])
            journal.flush()
            if len(coverage)%100<len(batch):ref.event('existing_baseline_comparison',rows=len(coverage),total=len(prior))
        journal.close()
        ref.require(set(coverage)==set(by_id) and len(coverage)==len(by_id),'Baseline comparison coverage differs')
        check=comparison(all_ref,all_new)
        report['baseline_comparison']={**check,'rows':len(coverage),'selected':selected,'backend':backend,
            'journal_sha256':ref.sha(args.work/'BASELINE_COMPARE.jsonl'),
            'seconds':time.monotonic()-compare_started,'refreshed_original_rows':refreshed}
        ref.require(check['passed'],'Existing full-context baseline differs')
        report['selected_eval_max_batch']=batch_size
        ref.atomic(args.work/'BENCHMARK.json',report)
    ref.require(ref.parameter_sha(model)==initial_sha,'Evaluation changed adapter')
    # Same logical optimizer window, RNG, coefficients and weights for both paths.
    pp=ref.parameters(model)
    original=[p.detach().cpu().clone() for p in pp]
    rng={'cpu':torch.get_rng_state(),'cuda':torch.cuda.get_rng_state_all(),'python':random.getstate()}
    def reset():
        for p,v in zip(pp,original):p.data.copy_(v)
        torch.set_rng_state(rng['cpu']);torch.cuda.set_rng_state_all(rng['cuda']);random.setstate(rng['python'])
        return torch.optim.AdamW(pp,lr=args.lr,weight_decay=.01,foreach=False)
    plan=ref.epoch_plan(train.entries,args.accumulation,3408)
    # Seed both paths with the SAME real reference update so LoRA A and B are
    # active, and AdamW moments exist before the tested subsequent update.
    warm_optimizer=reset()
    ref.update(model,warm_optimizer,train,plan['order'][:8],plan)
    original=[p.detach().cpu().clone() for p in pp]
    optimizer_seed=copy.deepcopy(warm_optimizer.state_dict())
    for state in optimizer_seed['state'].values():
        for key,value in state.items():
            if torch.is_tensor(value):state[key]=value.detach().cpu().clone()
    rng={'cpu':torch.get_rng_state(),'cuda':torch.cuda.get_rng_state_all(),'python':random.getstate()}
    def reset():
        for p,v in zip(pp,original):p.data.copy_(v)
        torch.set_rng_state(rng['cpu']);torch.cuda.set_rng_state_all(rng['cuda']);random.setstate(rng['python'])
        optimizer=torch.optim.AdamW(pp,lr=args.lr,weight_decay=.01,foreach=False)
        optimizer.load_state_dict(copy.deepcopy(optimizer_seed))
        return optimizer
    report['training_start']='same one-reference-update adapter and nonempty AdamW state'
    if report['selected_eval_backend']=='pipeline':
        model.eval()
        with torch.no_grad():
            expected=[float(ref.selected_loss(model,rows[i])) for i in chosen]
            actual=evaluation_losses_pipeline(model,[rows[i] for i in chosen]).cpu().tolist()
        report['pipeline_adapted_comparison']=comparison(expected,actual)
        ref.require(report['pipeline_adapted_comparison']['passed'],'Pipeline differs on trained adapter')
    windows={'normal8':plan['order'][8:16],
             'extreme3':[min(range(len(train)),key=lambda i:train.entries[i]['sequence_length']),
                         max(range(len(train)),key=lambda i:train.entries[i]['sequence_length']),
                         max(range(len(train)),key=lambda i:train.entries[i]['target_length'])]}
    for label,indices in windows.items():
        n_tokens=sum(train.entries[i]['sequence_length'] for i in indices)
        snapshots={}
        for name,loss_fn in [('reference',ref.selected_loss),('optimized',compute.training_loss)]:
            optimizer=reset();model.train()
            def run_window():
                total=0.
                for i in indices:
                    row=train[i];loss=loss_fn(model,row)*float(ref.coefficient(row,plan))
                    total+=float(loss.detach());loss.backward()
                    ref.event('gradient_row',window=label,implementation=name,index=i,length=row['sequence_length'])
                sync()
                gradients=[p.grad.detach().float().cpu().clone() for p in pp]
                norm=float(torch.nn.utils.clip_grad_norm_(pp,1.,error_if_nonfinite=True))
                optimizer.step()
                adapter=[p.detach().float().cpu().clone() for p in pp]
                state={i:{k:v.detach().cpu().clone() if torch.is_tensor(v) else v for k,v in s.items()} for i,s in optimizer.state_dict()['state'].items()}
                optimizer.zero_grad(set_to_none=True)
                return {'loss':total,'norm':norm,'gradients':gradients,'adapter':adapter,'optimizer':state}
            result,timing=measure(label+'_'+name,run_window,n_tokens)
            snapshots[name]=result
            report['training'].setdefault(label,{})[name]=timing
        a,b=snapshots['reference'],snapshots['optimized']
        def tensor_diff(xs,ys):
            ref.require(len(xs)==len(ys) and all(x.shape==y.shape and x.dtype==y.dtype for x,y in zip(xs,ys)), 'Tensor inventory differs')
            sq=ref_sq=dot=other_sq=0.;mx=0.
            for x,y in zip(xs,ys):
                x=x.double();y=y.double();d=x-y
                sq+=float((d*d).sum());ref_sq+=float((x*x).sum());other_sq+=float((y*y).sum());dot+=float((x*y).sum());mx=max(mx,float(d.abs().max()))
            return {'relative_l2':math.sqrt(sq/max(ref_sq,1e-30)),'max_abs':mx,'cosine':dot/math.sqrt(max(ref_sq*other_sq,1e-30))}
        named=[(n,p) for n,p in model.named_parameters() if p.requires_grad]
        groups={}
        for index,(name,param) in enumerate(named):
            family='A' if 'lora_A' in name else 'B' if 'lora_B' in name else 'other'
            groups.setdefault(family+':'+str(param.device),[]).append(index)
        group_checks={name:tensor_diff([a['gradients'][i] for i in ids],[b['gradients'][i] for i in ids]) for name,ids in groups.items()}
        ref.require(a['optimizer'].keys()==b['optimizer'].keys(),'Optimizer parameter inventory differs')
        for key,state in a['optimizer'].items():
            other=b['optimizer'][key]
            ref.require(state.keys()==other.keys(),'Optimizer state keys differ')
            ref.require(torch.equal(state['step'],other['step']),'Optimizer step differs')
            for field in state:
                ref.require(state[field].shape==other[field].shape and state[field].dtype==other[field].dtype,'Optimizer state shape/dtype differs')
        gd=tensor_diff(a['gradients'],b['gradients']);ad=tensor_diff(a['adapter'],b['adapter'])
        os_a=[v for s in a['optimizer'].values() for k,v in s.items() if k!='step']
        os_b=[v for s in b['optimizer'].values() for k,v in s.items() if k!='step']
        od=tensor_diff(os_a,os_b)
        group_pass=all(g['relative_l2']<=.005 and g['cosine']>=.99998 for g in group_checks.values())
        passed=group_pass and math.isclose(a['norm'],b['norm'],rel_tol=.005,abs_tol=1e-6) and gd['relative_l2']<=.005 and gd['cosine']>=.99998 and ad['max_abs']<=5e-5 and od['relative_l2']<=.01 and math.isclose(a['loss'],b['loss'],rel_tol=.002,abs_tol=.002)
        report['training'][label].update(gradient_groups=group_checks,gradient=gd,adapter=ad,optimizer=od,loss_reference=a['loss'],loss_optimized=b['loss'],
                                         norm_reference=a['norm'],norm_optimized=b['norm'],passed=passed,
                                         speedup=report['training'][label]['reference']['seconds']/report['training'][label]['optimized']['seconds'])
        ref.atomic(args.work/'BENCHMARK.json',report)
        del snapshots,a,b,os_a,os_b
    # Experiments are discarded; never write their adapters as training input.
    report['training_optimization_passed']=all(x['passed'] for x in report['training'].values())
    report['status']='passed' if report['training_optimization_passed'] else 'evaluation_only'
    report['benchmark_updates_discarded']=True
    ref.require(all(ref.sha(Path(__file__).with_name(n))==digest for n,digest in proof['code_sha256'].items()) and ref.sha(args.work/'BINDING.json')==proof['reference_binding_sha256'],'Benchmark code changed while executing')
    report['execution_proof_rechecked']=True
    ref.atomic(args.work/'BENCHMARK.json',report)
    ref.event('benchmark_complete',status=report['status'])
    # Separately qualify limited default-stream training overlap after the core
    # experiment has a durable result. Never reuse the model after a pair failure.
    pair_report={'status':'running','execution_proof':proof,'windows':{}}
    ref.atomic(args.work/'TRAIN_PIPELINE.json',pair_report)
    try:
        from cards31b_training_pipeline import accumulate_pair
        eligible=[i for i in plan['order'] if train.entries[i]['sequence_length']<=8192]
        pair_windows={'eligible8':eligible[:8],
                      'mixed5':[eligible[8],eligible[9],windows['extreme3'][1],windows['extreme3'][2],eligible[10]]}
        for label,indices in pair_windows.items():
            variants={};schedules=[]
            for variant in ['reference','compact_serial','pair']:
                optimizer=reset();model.train()
                def window_call():
                    total=0.
                    if variant in ('reference','compact_serial'):
                        loss_fn=ref.selected_loss if variant=='reference' else compute.training_loss
                        for i in indices:
                            loss=loss_fn(model,train[i])*float(ref.coefficient(train.entries[i],plan))
                            total+=float(loss.detach());loss.backward()
                    else:
                        for start in range(0,len(indices),2):
                            chunk=indices[start:start+2]
                            outcome=accumulate_pair(model,[train[i] for i in chunk],[ref.coefficient(train.entries[i],plan) for i in chunk])
                            total+=outcome['weighted_loss_sum'];schedules.append(outcome)
                    gradients=[p.grad.detach().float().cpu().clone() for p in pp]
                    norm=float(torch.nn.utils.clip_grad_norm_(pp,1.,error_if_nonfinite=True))
                    optimizer.step()
                    adapter=[p.detach().float().cpu().clone() for p in pp]
                    state={i:{k:v.detach().cpu().clone() if torch.is_tensor(v) else v for k,v in st.items()} for i,st in optimizer.state_dict()['state'].items()}
                    optimizer.zero_grad(set_to_none=True)
                    return {'gradients':gradients,'norm':norm,'adapter':adapter,'optimizer':state,'loss':total}
                result,timing=measure('training_pair_'+label+'_'+variant,window_call,sum(train.entries[i]['sequence_length'] for i in indices))
                variants[variant]=result
                pair_report['windows'].setdefault(label,{})[variant]=timing
            a,b=variants['reference'],variants['pair']
            gd=tensor_diff(a['gradients'],b['gradients']);ad=tensor_diff(a['adapter'],b['adapter'])
            groups={}
            for index,(name,param) in enumerate((n,p) for n,p in model.named_parameters() if p.requires_grad):
                family='A' if 'lora_A' in name else 'B'
                groups.setdefault(family+':'+str(param.device),[]).append(index)
            group_checks={name:tensor_diff([a['gradients'][i] for i in ids],[b['gradients'][i] for i in ids]) for name,ids in groups.items()}
            ref.require(a['optimizer'].keys()==b['optimizer'].keys(),'Pair optimizer inventory differs')
            for key,st in a['optimizer'].items():
                other=b['optimizer'][key]
                ref.require(st.keys()==other.keys() and torch.equal(st['step'],other['step']),'Pair optimizer steps differ')
            od=tensor_diff([v for st in a['optimizer'].values() for k,v in st.items() if k!='step'],
                           [v for st in b['optimizer'].values() for k,v in st.items() if k!='step'])
            passed=all(g['relative_l2']<=.005 and g['cosine']>=.99998 for g in group_checks.values()) and ad['max_abs']<=5e-5 and od['relative_l2']<=.01 and math.isclose(a['loss'],b['loss'],rel_tol=.002,abs_tol=.002) and math.isclose(a['norm'],b['norm'],rel_tol=.005,abs_tol=1e-6)
            pair_report['windows'][label].update(gradient=gd,gradient_groups=group_checks,adapter=ad,optimizer=od,
                                                loss_reference=a['loss'],loss_pair=b['loss'],passed=passed,schedules=schedules,
                                                speedup=pair_report['windows'][label]['reference']['seconds']/pair_report['windows'][label]['pair']['seconds'],
                                                speedup_over_compact=pair_report['windows'][label]['compact_serial']['seconds']/pair_report['windows'][label]['pair']['seconds'])
            ref.atomic(args.work/'TRAIN_PIPELINE.json',pair_report)
        pair_report['status']='passed' if all(v['passed'] for v in pair_report['windows'].values()) else 'rejected_numerics'
    except Exception as e:
        pair_report.update(status='rejected',error_type=type(e).__name__,reason=str(e)[:1000])
    pair_report['execution_proof_rechecked']=all(ref.sha(Path(__file__).with_name(n))==digest for n,digest in proof['code_sha256'].items())
    ref.atomic(args.work/'TRAIN_PIPELINE.json',pair_report)
    ref.event('training_pipeline_experiment_completed',status=pair_report['status'])


if __name__=='__main__':
    p=argparse.ArgumentParser()
    for name in ['dataset','model','legacy-kit','work','canary-work']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--mode');p.add_argument('--lr',type=float,default=2e-5);p.add_argument('--accumulation',type=int,default=8)
    args=p.parse_args()
    try:main(args)
    except BaseException as e:
        ref.atomic(args.work/'BENCHMARK_ERROR.json',{'type':type(e).__name__,'message':str(e)[:1500]})
        raise
