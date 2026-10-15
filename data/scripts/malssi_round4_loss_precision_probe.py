"""Bounded diagnosis of same-hidden-state BF16/compiled loss; no weight update."""
import argparse
import gc
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import traceback

from malssi_gpu_validation import require, compute_apps, smi, same_gpu_uuid
from counseling_pipeline.gemma4_token_validation import encode_example, collate_examples


def main():
    p=argparse.ArgumentParser()
    for name in ('workspace','model-dir','probes'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--gpu-uuid',required=True);a=p.parse_args()
    root=Path('/home/slim/choieram').resolve();task=a.workspace.resolve()
    require(all(x.resolve().is_relative_to(root) for x in (task,a.model_dir,a.probes)), 'Paths outside authorized root')
    require(os.environ.get('CUDA_VISIBLE_DEVICES')==a.gpu_uuid,'Missing exact UUID pin')
    require(not any(a.gpu_uuid in x for x in compute_apps()),'Pinned GPU busy')
    os.chdir(task);os.environ['UNSLOTH_RETURN_LOGITS']='0'
    report={'status':'running','gpu_uuid':a.gpu_uuid,'before':smi(),'optimizer_steps':0,'weights_saved':False,
            'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'checks':{}}
    path=task/'reports/loss_precision_diagnosis.json'
    def event(name,value):
        report['checks'][name]=value;path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({'event':name,'value':value},ensure_ascii=False),flush=True)
    try:
        from unsloth import FastModel
        import torch
        from transformers import AutoTokenizer
        require(torch.cuda.device_count()==1 and same_gpu_uuid(torch.cuda.get_device_properties(0).uuid,a.gpu_uuid),'Wrong visible GPU')
        tok=AutoTokenizer.from_pretrained(str(a.model_dir),local_files_only=True)
        model,_=FastModel.from_pretrained(model_name=str(a.model_dir),max_seq_length=4096,dtype=torch.bfloat16,
                                        load_in_4bit=True,full_finetuning=False,device_map={'':0},local_files_only=True)
        model=FastModel.get_peft_model(model,finetune_vision_layers=False,finetune_language_layers=True,
                                      finetune_attention_modules=True,finetune_mlp_modules=True,r=8,lora_alpha=8,
                                      lora_dropout=0,bias='none',random_state=3407,use_gradient_checkpointing='unsloth')
        require({str(v.device) for v in model.parameters()}=={'cuda:0'},'Unexpected device')
        trainable=[(n,v) for n,v in model.named_parameters() if v.requires_grad]
        require(trainable and all('lora_' in n for n,v in trainable),'Unexpected trainable weights')
        def adapter_hash():
            h=hashlib.sha256()
            for n,v in trainable:h.update(n.encode());h.update(v.detach().cpu().contiguous().view(torch.uint8).numpy().tobytes())
            return h.hexdigest()
        initial_hash=adapter_hash()
        base=model.get_base_model();weight=base.lm_head.weight;bias=getattr(base.lm_head,'bias',None)
        require(not weight.requires_grad,'Head must be frozen')
        ce=importlib.import_module('unsloth_zoo.fused_losses.cross_entropy_loss')
        modules={name:{flag:getattr(module,flag,None) for flag in ('UNSLOTH_ENABLE_CCE','HAS_CUT_CROSS_ENTROPY','UNSLOTH_COMPILE_DISABLE')}
                 for name,module in list(sys.modules.items()) if 'compiled_module_gemma4' in name}
        event('runtime',{'compiled_module_flags':modules,'fused_ce_compile_supported':ce._FUSED_CE_COMPILE_SUPPORTED,
                         'ce_module_sha256':hashlib.sha256(Path(ce.__file__).read_bytes()).hexdigest(),
                         'head_dtype':str(weight.dtype),'head_requires_grad':weight.requires_grad,'bias_present':bias is not None,
                         'environment':{k:os.environ.get(k) for k in ('UNSLOTH_CE_LOSS_N_CHUNKS','UNSLOTH_CE_LOSS_TARGET_GB')},
                         'fp32_matmul_precision':'highest','lora_hash_before':initial_hash})
        raw=[json.loads((a.probes/f'probe_cap_{cap}.json').read_text())['source_row'] for cap in (256,512)]
        encoded=[encode_example(row,tok) for row in raw]
        batch=collate_examples(encoded,tok.pad_token_id,512)
        tensors={k:torch.tensor(v,device='cuda',dtype=torch.long) for k,v in batch.items()}
        labels=torch.full_like(tensors['labels'],-100)
        for i,row in enumerate(encoded):
            end=[j for j,v in enumerate(row['labels']) if v==tok.convert_tokens_to_ids('<turn|>')]
            require(len(end)==1,'Expected one response end');labels[i,end[0]]=row['labels'][end[0]]
        tensors['labels']=labels
        torch.set_float32_matmul_precision('highest');model.train()
        captured=[]
        handle=base.model.register_forward_hook(lambda module,args,out:captured.append(out.last_hidden_state.detach().clone()))
        out=model(**tensors,use_cache=False);actual=float(out.loss.detach());handle.remove()
        require(len(captured)==1,'Missing final hidden state');hidden=captured.pop();del out
        gc.collect();torch.cuda.empty_cache()
        cap=base.config.get_text_config().final_logit_softcapping
        def reference(logits):
            return float(torch.nn.functional.cross_entropy(logits[:,:-1,:].float().reshape(-1,logits.shape[-1]),labels[:,1:].reshape(-1),ignore_index=-100))
        with torch.no_grad():
            logits=base.lm_head(hidden)
            eager_bf16=reference(torch.tanh(logits/cap)*cap)
            float_cap=torch.tanh(logits.float()/cap)*cap
            mixed_fp32=reference(float_cap)
            mixed_final_bf16=reference(float_cap.to(torch.bfloat16))
        event('same_hidden_same_raw_head_logits',{'model_fused_end_loss':actual,
              'eager_bf16_softcap_ce':eager_bf16,'fp32_softcap_after_bf16_matmul_ce':mixed_fp32,
              'fp32_softcap_then_bf16_round_ce':mixed_final_bf16,'hidden_dtype':str(hidden.dtype),
              'hidden_shape':list(hidden.shape),'head_logits_dtype':str(logits.dtype),'softcap':cap,
              'note':'Same exact hidden states and same BF16 head logits; only softcap intermediate/final rounding differs.'})
        del logits,float_cap;gc.collect();torch.cuda.empty_cache()
        direct={}
        # Same full shape, one explicit chunk, both modes. Default model may choose
        # another chunk count; this isolates compile effects without claiming equality
        # between different GEMM shapes. Unshifted source labels are shifted once by API.
        for compiled in (False,True):
            own_hidden=hidden.clone().requires_grad_(True)
            value=ce.unsloth_fused_ce_loss(None,own_hidden,weight,bias,labels,torch_compile=compiled,
                                         n_chunks=1,shift_labels=True,logit_softcapping=cap)
            direct[str(compiled)]={'loss':float(value.detach()),'n_chunks':1,'shift_labels':True}
            del value,own_hidden;gc.collect();torch.cuda.empty_cache()
            event('same_hidden_direct_fused_calls',direct)
        event('differences',{'compiled_vs_original':abs(direct['True']['loss']-actual),
                            'uncompiled_vs_eager_bf16':abs(direct['False']['loss']-eager_bf16),
                            'compiled_vs_fp32_softcap':abs(direct['True']['loss']-mixed_fp32),
                            'compiled_vs_fp32_softcap_final_bf16':abs(direct['True']['loss']-mixed_final_bf16)})
        final_hash=adapter_hash();require(final_hash==initial_hash,'Weights changed')
        event('weights_unchanged',{'passed':True,'lora_hash_after':final_hash})
        report['status']='diagnosis_completed';report['equivalence_gate_passed']=False
        report['scope']='Numerical diagnosis on one padded two-row batch and two end labels. It does not waive prior tolerance failures or verify Trainer/optimizer.'
    except Exception as exc:
        report.update(status='failed',error_type=type(exc).__name__,error=str(exc),traceback=traceback.format_exc())
        print(traceback.format_exc(),flush=True);raise
    finally:
        report['after_before_process_exit']=smi();path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
