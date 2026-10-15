"""One pinned GPU: actual fused-loss/reference and generation-boundary probes. No optimizer."""
import argparse,gc,hashlib,importlib.metadata,inspect,json,os,sys,time,traceback
from pathlib import Path

from malssi_gpu_validation import require,smi,compute_apps,same_gpu_uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from counseling_pipeline.gemma4_token_validation import encode_example,collate_examples
from counseling_pipeline.gemma4_generation_validation import prepare_generation,inspect_generation


def digest(values):
    return hashlib.sha256(json.dumps(values,separators=(',',':')).encode()).hexdigest()


def main():
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--model-dir',type=Path,required=True);p.add_argument('--probes',type=Path,required=True);p.add_argument('--gpu-uuid',required=True);a=p.parse_args()
    root=Path('/home/slim/choieram').resolve();task=a.workspace.resolve()
    require(all(x.resolve().is_relative_to(root) for x in [task,a.model_dir,a.probes]),'Paths outside authorized root')
    require(os.environ.get('CUDA_VISIBLE_DEVICES')==a.gpu_uuid,'Exact GPU UUID pin required')
    require(not any(a.gpu_uuid in line for line in compute_apps()),'Pinned GPU is busy; do not switch or stop its owner')
    os.chdir(task);report={'status':'running','pid':os.getpid(),'gpu_uuid':a.gpu_uuid,'optimizer_steps':0,'training_run':False,'weights_saved':False,'before':smi(),'checks':{},'errors':[],'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    path=task/'reports/gpu_loss_generation.json'
    def save():path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    def event(key,value):report['checks'][key]=value;save();print(json.dumps({'event':key,'value':value},ensure_ascii=False),flush=True)
    model=None
    try:
        os.environ['UNSLOTH_RETURN_LOGITS']='0'
        from unsloth import FastModel
        import torch
        from transformers import AutoTokenizer
        require(torch.cuda.device_count()==1,'Exactly one visible GPU required')
        require(same_gpu_uuid(torch.cuda.get_device_properties(0).uuid,a.gpu_uuid),'Wrong physical GPU')
        report['versions']={x:importlib.metadata.version(x) for x in ['torch','transformers','unsloth','peft','bitsandbytes']}
        tok=AutoTokenizer.from_pretrained(str(a.model_dir),local_files_only=True)
        model,_=FastModel.from_pretrained(model_name=str(a.model_dir),max_seq_length=4096,dtype=torch.bfloat16,load_in_4bit=True,full_finetuning=False,device_map={'':0},local_files_only=True)
        model=FastModel.get_peft_model(model,finetune_vision_layers=False,finetune_language_layers=True,finetune_attention_modules=True,finetune_mlp_modules=True,r=8,lora_alpha=8,lora_dropout=0,bias='none',random_state=3407,use_gradient_checkpointing='unsloth')
        require({str(x.device) for x in model.parameters()}=={'cuda:0'},'Unexpected parameter placement')
        parameters=[(n,x) for n,x in model.named_parameters() if x.requires_grad]
        require(parameters and all('lora_' in n for n,x in parameters),'Unexpected trainable parameter')
        def adapter_hash():
            h=hashlib.sha256()
            for n,x in parameters:h.update(n.encode());h.update(x.detach().cpu().contiguous().view(torch.uint8).numpy().tobytes())
            return h.hexdigest()
        before=adapter_hash();event('model_loaded',{'parameter_devices':['cuda:0'],'lora_hash_before':before})
        raw=[json.loads((a.probes/f'probe_cap_{cap}.json').read_text())['source_row'] for cap in (256,512)]
        encoded=[encode_example(x,tok) for x in raw];batch=collate_examples(encoded,tok.pad_token_id,512)
        tensors={k:torch.tensor(v,device='cuda',dtype=torch.long) for k,v in batch.items()}
        labels=tensors['labels'];turn_end=tok.convert_tokens_to_ids('<turn|>')
        only_first=torch.full_like(labels,-100);only_end=torch.full_like(labels,-100)
        positions=[]
        for i,row in enumerate(encoded):
            first=row['prefix_length'];ends=[j for j,v in enumerate(row['labels']) if v==turn_end]
            require(len(ends)==1,'Expected exactly one supervised response-end token')
            only_first[i,first]=labels[i,first];only_end[i,ends[0]]=labels[i,ends[0]]
            positions.append({'first_supervised_label_position':first,'first_predicting_logit_position':first-1,'end_label_position':ends[0],'end_predicting_logit_position':ends[0]-1,'end_token_id':turn_end,'padding_count':len(batch['input_ids'][i])-row['sequence_length']})
        model.train();torch.manual_seed(3407)
        torch.set_float32_matmul_precision('highest')
        base=model.get_base_model()
        captured=[]
        def capture_hidden(module,args,output):
            captured.append(output.last_hidden_state.detach().clone())
        capture_handle=base.model.register_forward_hook(capture_hidden)
        softcap=base.config.get_text_config().final_logit_softcapping
        def fp32_reference(hidden,mask,shift=1):
            # Reuse the exact states from the fused forward. Chunk only the vocabulary
            # to avoid converting the entire large BF16 lm_head to FP32 at once.
            indices=(mask!=-100).nonzero()
            require(bool((indices[:,1]>=shift).all()),'Supervision cannot precede shifted predictor')
            vectors=hidden[indices[:,0],indices[:,1]-shift].float()
            target=mask[indices[:,0],indices[:,1]]
            total=torch.full((len(target),),-float('inf'),device='cuda',dtype=torch.float32)
            selected=torch.zeros_like(total)
            weight=base.lm_head.weight
            bias=getattr(base.lm_head,'bias',None)
            for start in range(0,weight.shape[0],4096):
                end=min(start+4096,weight.shape[0])
                values=torch.nn.functional.linear(vectors,weight[start:end].float(),None if bias is None else bias[start:end].float())
                if softcap:values=torch.tanh(values/softcap)*softcap
                total=torch.logaddexp(total,torch.logsumexp(values,dim=-1))
                present=(target>=start)&(target<end)
                selected[present]=values[present,target[present]-start]
            return float((total-selected).mean())
        losses={};fp32_details={};fused_hidden=None
        masks=[('all_targets',labels),('first_target_only',only_first),('response_end_only',only_end)]
        # Exercise the actual model's normal no-logits training loss path first.
        for name,mask in masks:
            captured.clear()
            os.environ['UNSLOTH_RETURN_LOGITS']='0'
            out=model(input_ids=tensors['input_ids'],attention_mask=tensors['attention_mask'],labels=mask,use_cache=False)
            losses[name]=float(out.loss.detach());require(torch.isfinite(out.loss).item(),'Nonfinite fused loss')
            require(len(captured)==1,'Expected one final hidden-state capture')
            with torch.no_grad():reference=fp32_reference(captured[0],mask)
            diff=abs(losses[name]-reference)
            fp32_details[name]={'model_fused_loss':losses[name],'same_hidden_fp32_shifted_ce':reference,'absolute_difference':diff,'atol':0.002,'rtol':0.002,'passed':diff<=0.002+0.002*abs(reference),'supervised_items':int((mask!=-100).sum()),'head_dtype':str(base.lm_head.weight.dtype),'final_logit_softcapping':softcap}
            if name=='response_end_only':
                with torch.no_grad():fp32_details[name]['unshifted_negative_control_ce']=fp32_reference(captured[0],mask,shift=0)
            if fused_hidden is None:fused_hidden=captured[0]
            else:fp32_details[name]['hidden_identical_to_first_fused_run']=bool(torch.equal(fused_hidden,captured[0]))
            event('same_hidden_fp32_reference',fp32_details)
            del out;captured.clear();gc.collect();torch.cuda.empty_cache()
        os.environ['UNSLOTH_RETURN_LOGITS']='1'
        with torch.no_grad():
            out=model(**tensors,use_cache=False)
            logits=out.logits.float()
            require(isinstance(logits,torch.Tensor) and logits.shape[:2]==labels.shape,'Expected complete returned logits')
            details={}
            for name,mask in masks:
                expected=torch.nn.functional.cross_entropy(logits[:,:-1,:].reshape(-1,logits.shape[-1]),mask[:,1:].reshape(-1),ignore_index=-100)
                reference=float(expected);difference=abs(losses[name]-reference)
                passed=difference<=0.002+0.002*abs(reference)
                details[name]={'model_fused_loss':losses[name],'manual_shifted_ce':reference,'absolute_difference':difference,'atol':0.002,'rtol':0.002,'passed':passed,'supervised_items':int((mask[:,1:]!=-100).sum())}
        require(len(captured)==1,'Expected reference hidden-state capture')
        event('actual_model_loss_reference',{'comparisons':details,'positions':positions,'hidden_identical_to_fused':bool(torch.equal(captured[0],fused_hidden)),'hidden_max_abs_difference':float((captured[0]-fused_hidden).abs().max()),'scope':'training-mode LoRA; fused forward grad enabled; returned BF16 logits branch under no_grad, with independent FP32 reference on exact fused states above','ignored_labels_mean':'labels[j]=-100 excludes prediction loss at logits[j-1], not all context/hidden-state gradients'})
        capture_handle.remove();captured.clear()
        del out,logits,tensors,labels,only_first,only_end,masks,mask,fused_hidden;gc.collect();torch.cuda.empty_cache()
        model.eval();FastModel.for_inference(model)
        os.environ['UNSLOTH_RETURN_LOGITS']='0'
        genconf=json.loads((a.model_dir/'generation_config.json').read_text());stop_ids=genconf['eos_token_id']
        require(turn_end in stop_ids,'Generation configuration omits native turn end')
        synthetic={'messages':[{'role':'system','content':'사용자의 요청에 한국어로 간결하게 답하세요.'},{'role':'user','content':'오늘 대화를 여기서 마칠게요. 짧은 인사 한 문장으로 답해주세요.'},{'role':'assistant','content':'이 검사용 목표 문장은 모델 입력에 제공하지 않습니다.'}],'loss_message_mask':[0,0,1]}
        long_raw=json.loads((a.probes/'probe_cap_4096.json').read_text())['source_row']
        cases=[('synthetic_stop_control',synthetic,64),('actual_source_256',raw[0],128),('actual_source_4096',long_raw,64)]
        generation_results=[]
        for name,row,reserve in cases:
            prepared=prepare_generation(row,tok,max_new_tokens=reserve,context_budget=4096)
            input_ids=torch.tensor([prepared['input_ids']],device='cuda');attention=torch.ones_like(input_ids)
            observed=[]
            base=model.get_base_model()
            def hook(module,args,kwargs):
                value=kwargs.get('input_ids',args[0] if args else None)
                if not observed and isinstance(value,torch.Tensor):observed.append(value.detach().cpu().tolist()[0])
            handle=base.register_forward_pre_hook(hook,with_kwargs=True)
            torch.cuda.reset_peak_memory_stats();start=time.monotonic()
            try:
                with torch.inference_mode():
                    output=model.generate(input_ids=input_ids,attention_mask=attention,max_new_tokens=reserve,do_sample=False,num_beams=1,eos_token_id=stop_ids,pad_token_id=tok.pad_token_id,use_cache=True,token_healing=False)
                torch.cuda.synchronize()
            finally:handle.remove()
            seq=output.detach().cpu().tolist()[0];result=inspect_generation(seq,prepared,tok,stop_ids=stop_ids)
            require(bool(observed) and observed[0]==prepared['input_ids'],'Actual model prefill differs from validated prefix')
            generation_results.append({'case':name,'source_row_id':row.get('id'),'prefix_tokens':prepared['prefix_length'],'max_new_tokens':reserve,'context_budget':4096,'input_sha256':digest(prepared['input_ids']),'actual_prefill_sha256':digest(observed[0]),'actual_prefill_exact_match':True,'seconds':time.monotonic()-start,'peak_allocated_gib':torch.cuda.max_memory_allocated()/2**30,**result})
            event('generation',generation_results)
            del input_ids,attention,output;gc.collect();torch.cuda.empty_cache()
        require(any(x['stopped_on_eos'] for x in generation_results),'No natural EOS observed')
        after=adapter_hash();require(before==after,'LoRA weights changed')
        event('weights_unchanged',{'passed':True,'lora_hash_after':after})
        report['status']='passed_with_bf16_branch_difference' if all(v['passed'] for v in fp32_details.values()) and not all(v['passed'] for v in details.values()) else ('passed' if all(v['passed'] for v in fp32_details.values()) else 'loss_reference_mismatch')
        report['limitations']=['No optimizer/Trainer step, performance evaluation or HOP approval.','Generation smoke has three cases; natural termination is distinct from content quality.','BF16 returned-logit CE and fused CE are separately reported; a failed tolerance check is never relabeled as passed.']
    except Exception as exc:
        report['status']='failed';report['errors'].append({'type':type(exc).__name__,'message':str(exc),'traceback':traceback.format_exc()});print(traceback.format_exc(),flush=True);raise
    finally:
        report['after_before_process_exit']=smi();save()
    return 0 if report['status']=='passed' else 1

if __name__=='__main__':raise SystemExit(main())
