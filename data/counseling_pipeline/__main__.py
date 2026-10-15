from argparse import ArgumentParser
from pathlib import Path
import json
import sys
import importlib.util
from .ingest import ingest
from . import annotations


def main():
    parser=ArgumentParser(description='Private counseling corpus pipeline; never calls external AI APIs')
    parser.add_argument('command',choices=['all','ingest','numeric','suitability','prepare-ai','verify','check','ai-batch','import-generation','import-verification','import-human','environment'])
    parser.add_argument('--config',default='configs/default.json')
    parser.add_argument('--source');parser.add_argument('--output')
    parser.add_argument('--definitions',default='counseling_pipeline/label_definitions.json')
    parser.add_argument('--file');parser.add_argument('--limit',type=int,default=20)
    args=parser.parse_args();config=json.loads(Path(args.config).read_text())
    source=Path(args.source or config['source']);output=Path(args.output or config['output']);output.mkdir(parents=True,exist_ok=True)
    if args.command=='environment':
        result={'python':sys.version,'executable':sys.executable,'modules':{x:bool(importlib.util.find_spec(x)) for x in ['numpy','scipy','sklearn','torch','transformers','sentence_transformers','gensim','kiwipiepy']}}
    elif args.command=='check':
        from .checks import check_code
        result=check_code(output)
    elif args.command=='ingest':result=ingest(source,output)
    elif args.command=='numeric':
        from .numeric import representations
        result=representations(output,config)
    elif args.command=='suitability':
        from .suitability import assess
        result=assess(output)
    elif args.command=='prepare-ai':
        result=annotations.prepare(output,args.definitions);annotations.export_reviews(output)
    elif args.command=='verify':
        from .verify import verify
        result=verify(output,source)
    elif args.command=='all':
        from .numeric import representations
        from .verify import verify
        print('Stage 1/4: source ingestion',flush=True);ingest(source,output)
        print('Stage 2/4: train-only numeric representations',flush=True);representations(output,config)
        print('Stage 3/4: annotation queue and truthful status exports',flush=True);annotations.prepare(output,args.definitions);annotations.export_reviews(output)
        print('Stage 4/4: verification and report',flush=True);result=verify(output,source)
    elif args.command=='ai-batch':
        if not args.file:parser.error('--file required')
        result={'exported':annotations.export_batch(output,args.file,args.limit)}
    else:
        if not args.file:parser.error('--file required')
        imported=[]
        for line in Path(args.file).read_text().splitlines():
            if not line.strip():continue
            record=json.loads(line)
            if args.command=='import-human':rid=annotations.import_human(output,args.definitions,record)
            else:rid=annotations.import_record(output,args.definitions,record,args.command.removeprefix('import-'))
            imported.append(rid)
        annotations.export_reviews(output);result={'imported':len(imported),'record_ids':imported}
    # Keep raw counseling contents out of console logs.
    keys=['counts','status_counts','splits','completion_status','checks_passed','structural_checks_passed','clinical_training_ready','failures','full_spec_complete','actual_generation_records','actual_verification_records','job_status','label_status']
    compact={k:result[k] for k in keys if k in result}
    if 'artifacts' in result:compact['artifact_count']=len(result['artifacts'])
    if not compact:compact={'status':'completed','artifact_count':len(result.get('artifacts',[]))} if 'artifacts' in result else result
    print(json.dumps(compact,ensure_ascii=False,indent=2))
    if result.get('checks_passed') is False:return 1
    return 0

if __name__=='__main__':raise SystemExit(main())
