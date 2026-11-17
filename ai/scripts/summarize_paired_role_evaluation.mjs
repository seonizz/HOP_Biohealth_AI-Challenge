// M01 measures first-response format only. Semantic judgments remain separate.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateSchema} from '../../app/src/relationship-agent.js';

const rows = file => fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse);
const key = row => `${row.arm}\0${row.request_id}`;
export function schemaResult(request,text) {
  try {
    if(typeof text!=='string'||!text.trim()) throw new Error('empty_response');
    if(request.format==='text') {
      if(text.length>8000) throw new Error('text_length_exceeded');
    } else {
      const payload=JSON.parse(request.messages.at(-1).content);
      validateSchema(JSON.parse(text),payload.output_schema);
    }
    return {schema_valid:true,reason:null};
  } catch(error) {return {schema_valid:false,reason:error.code||error.message};}
}

export function aggregate(assignments,outputs,attempts=[]) {
  const expected=new Map();
  for(const row of assignments) {
    if(expected.has(key(row))) throw new Error('duplicate_assignment');
    expected.set(key(row),row);
  }
  const received=new Map();
  for(const output of outputs) {
    if(!expected.has(key(output))||received.has(key(output))) throw new Error('unknown_or_duplicate_output');
    if(!['output_received','failed'].includes(output.execution_status)) throw new Error('invalid_execution_status');
    received.set(key(output),output);
  }
  const started=new Set(attempts.filter(row=>row.event==='started').map(key));
  const judgments=assignments.map(row=>{
    const output=received.get(key(row));
    const execution_status=output?.execution_status||(started.has(key(row))?'missing_execution_evidence':'not_run');
    return {arm:row.arm,request_id:row.request_id,case_id:row.case_id,
      source_group_id:row.source_group_id,task:row.task,output_stage:'first_draft',
      execution_status,
      ...(execution_status==='output_received'?schemaResult(row.request,output.text):
        {schema_valid:execution_status==='failed'?false:null,reason:execution_status})};
  });
  const tasks=[...new Set(judgments.map(row=>row.task))].sort();
  const metrics=[];
  for(const task of tasks) for(const arm of [...new Set(assignments.map(row=>row.arm))]) {
    const subset=judgments.filter(row=>row.task===task&&row.arm===arm);
    const count=status=>subset.filter(row=>row.execution_status===status).length;
    const not_run_count=count('not_run'), missing_execution_evidence_count=count('missing_execution_evidence'),
      numerator=subset.filter(row=>row.schema_valid===true).length;
    metrics.push({metric_id:'M01',task,arm,unit:'logical_request',output_stage:'first_draft',
      assigned_count:subset.length,received_count:count('output_received'),failed_count:count('failed'),not_run_count,missing_execution_evidence_count,
      source_group_count:new Set(subset.map(row=>row.source_group_id)).size,
      numerator,denominator:subset.length,value:not_run_count||missing_execution_evidence_count?null:numerator/subset.length,
      status:not_run_count||missing_execution_evidence_count?'incomplete':'measured',
      semantic_quality_evaluated:false});
  }
  return {schema:'malssi-paired-format-summary-v1',metrics,judgments,
    comparisons:tasks.map(task=>{
      const baseline=metrics.find(row=>row.task===task&&row.arm==='baseline');
      const trained=metrics.find(row=>row.task===task&&row.arm==='trained');
      return {metric_id:'M01',task,baseline_value:baseline?.value??null,trained_value:trained?.value??null,
        difference:baseline?.value!=null&&trained?.value!=null?trained.value-baseline.value:null,
        ci95:null,reason:'development_panel_no_confirmatory_inference'};
    })};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=process.argv[2];
  const summary=aggregate(rows(path.join(root,'assignments.jsonl')),rows(path.join(root,'outputs.jsonl')),
    rows(path.join(root,'attempts.jsonl')));
  fs.writeFileSync(path.join(root,'format-metrics.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({metrics:summary.metrics,comparisons:summary.comparisons}));
}
