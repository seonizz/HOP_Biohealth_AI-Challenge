// Read-only replay of frozen memory-review targets against current app callbacks.
// No model calls, target repair, semantic judgment, or corpus text in reports.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const same=(a,b)=>canonical(a)===canonical(b);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const extension='\nreview_target.input.reported_dialogue는 이용자의 전체 원문이며 시점 순서대로 대조하세요. 구조화된 원문 조각은 정답 표지가 아니고 이전 보고도 포함합니다.';

export async function checkMemoryRow(row,requestCombinedStateReview) {
  const result={schema_equal:false,input_equal:false,prompt_equal:false,validator_passed:false};
  try {
    if(row.task!=='memory_review'||!Array.isArray(row.messages)||row.messages.length!==3||
       row.messages.map(m=>m.role).join(',')!=='system,user,assistant')throw new Error();
    const frozen=JSON.parse(row.messages[1].content),target=JSON.parse(row.messages[2].content);
    if(frozen.stage!=='turn_review'||!frozen.data?.review_target||
       frozen.data.questions!==null||frozen.data.safety!==null||target.questions!==null||target.safety!==null)throw new Error();
    const original=digest(row);
    let calls=0;
    await requestCombinedStateReview({async agentComplete(stage,prompt,data,schema,_operation,validate) {
      calls++;
      if(stage!=='turn_review'||typeof validate!=='function')throw new Error();
      result.schema_equal=same(frozen.output_schema,schema);
      result.input_equal=same(frozen.data,data);
      result.prompt_equal=row.messages[0].content===prompt+extension;
      validate(structuredClone(target));
      result.validator_passed=true;
      return structuredClone(target);
    }},structuredClone(frozen.data),{});
    if(calls!==1||digest(row)!==original)throw new Error();
    return result;
  } catch {
    // Validator exceptions may quote private source text: never propagate them.
    return {...result,validator_passed:false,error:'current_callback_rejected'};
  }
}

export async function checkFiles(files,requestCombinedStateReview) {
  const report={rows_checked:0,rows_rejected:0,schema_drift_rows:0,input_drift_rows:0,prompt_drift_rows:0,
    task:'memory_review',semantic_quality_evaluated:false,previous_semantic_approval_reused:false,model_calls:0};
  for(const file of files) {
    const input=fs.createReadStream(file);
    const stream=file.endsWith('.gz')?input.pipe(createGunzip()):input;
    // Forward source errors so malformed/missing input cannot leave the stream pending.
    if(stream!==input)input.on('error',error=>stream.destroy(error));
    for await(const line of readline.createInterface({input:stream,crlfDelay:Infinity})) {
      if(!line.trim())throw new Error('invalid_jsonl');
      const row=JSON.parse(line);
      if(row.task!=='memory_review')continue;
      const result=await checkMemoryRow(row,requestCombinedStateReview);
      report.rows_checked++;
      if(!result.validator_passed)report.rows_rejected++;
      if(!result.schema_equal)report.schema_drift_rows++;
      if(!result.input_equal)report.input_drift_rows++;
      if(!result.prompt_equal)report.prompt_drift_rows++;
    }
  }
  report.status=report.rows_checked===0?'not_covered':report.rows_rejected?'incompatible':
    report.schema_drift_rows||report.input_drift_rows||report.prompt_drift_rows?'compatible_with_contract_drift':'compatible';
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if(args[0]!=='--repo'||args.length<3)throw new Error('invalid_arguments');
    const {requestCombinedStateReview}=await import(pathToFileURL(path.join(args[1],'app/src/relationship-turn.js')));
    const report=await checkFiles(args.slice(2),requestCombinedStateReview);
    console.log(JSON.stringify(report));
    process.exitCode=report.rows_rejected||!report.rows_checked?2:0;
  } catch {
    console.log(JSON.stringify({status:'check_failed',error:'memory_contract_check_failed',
      semantic_quality_evaluated:false,previous_semantic_approval_reused:false,model_calls:0}));
    process.exitCode=2;
  }
}
