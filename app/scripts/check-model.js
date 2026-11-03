import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {configuredModelGateway} from '../src/model-config.js';
import {validateSchema} from '../src/relationship-agent.js';

// A synthetic connection check, with no conversation, database or credentials
// in its output. Its deadline applies only to this diagnostic command.
export async function checkModelConnections({env=process.env,generate=false,fetchImpl,timeoutMs=60000}={}) {
  let writer;
  try { writer=configuredModelGateway({env,fetchImpl,retryFailures:false,diagnosticLogger:null}); }
  catch { return {ok:false,checks:[{role:'configuration',ok:false,code:'MODEL_CONFIGURATION_INVALID'}]}; }
  if(!writer)return {ok:false,checks:[{role:'configuration',ok:false,code:'MODEL_NOT_CONFIGURED'}]};
  const checks=[];
  for(const [role,gateway] of [['writer',writer],...(writer.reviewGateway?[['reviewer',writer.reviewGateway]]:[])]) {
    const format=gateway.protocol==='json_prompt'?'prompt':gateway.protocol==='json_schema'?'json_schema':gateway.agentFormat;
    const writerRole=role==='writer',agent=gateway.protocol==='relationship_agent';
    const scoped=writerRole&&agent&&gateway.stateMode==='combined_blocks';
    const configuration={role,protocol:gateway.protocol,format,stream:gateway.streamJson,discovery:gateway.discoverTokenLimits,
      serverGpuOnly:gateway.serverGpuOnly,stateMode:gateway.stateMode,
      optimizations:{reuseFinalDraft:writerRole&&agent&&gateway.reuseFinalDraft,skipFinalExtras:gateway.skipFinalExtras,
        stageScopedQuestionRules:scoped&&gateway.stageScopedQuestionRules,blockScopedInputs:scoped&&gateway.blockScopedInputs,
        compactReviewInputs:writerRole&&agent&&gateway.compactReviewInputs,
        scopedQualityRefinement:writerRole&&agent&&!gateway.skipFinalExtras&&gateway.scopedQualityRefinement,
        bundleFinalReviews:writerRole&&agent&&!gateway.skipFinalExtras&&gateway.bundleFinalReviews,
        bundleTurnReviews:scoped&&gateway.bundleTurnReviews,
        reuseReviewedName:scoped&&gateway.reuseReviewedName,
        reuseReviewedSafety:scoped&&!gateway.bundleTurnReviews&&gateway.reuseReviewedSafety,
        tokenPolicyReuseRequested:gateway.discoverTokenLimits&&gateway.reuseTokenPolicy},
      inactiveOptions:writerRole?[
        ...(scoped&&gateway.bundleTurnReviews&&gateway.reuseReviewedSafety?['MODEL_REUSE_REVIEWED_SAFETY']:[]),
        ...(!scoped&&gateway.stageScopedQuestionRules?['MODEL_STAGE_SCOPED_QUESTION_RULES']:[]),
        ...(!scoped&&gateway.blockScopedInputs?['MODEL_BLOCK_SCOPED_INPUTS']:[]),
        ...(gateway.skipFinalExtras&&gateway.scopedQualityRefinement?['MODEL_SCOPED_QUALITY_REFINEMENT']:[]),
      ]:[]};
    if(!generate){checks.push({...configuration,ok:true,mode:'configuration_only'});continue;}
    const schema={type:'object',properties:{ok:{type:'boolean',const:true}},required:['ok'],additionalProperties:false};
    try {
      const signal=AbortSignal.timeout(timeoutMs);
      if(gateway.protocol==='relationship_agent') {
        await gateway.operation({signal},operation=>gateway.agentComplete('connection_check',
          'This is a synthetic API connection check. Return only the JSON object {"ok":true}.',
          {synthetic:true},schema,operation,value=>validateSchema(value,schema)),{retryFailures:false});
      } else {
        // Legacy protocols have different request bodies and validators. Use
        // their actual state path with no conversation rather than reporting
        // success from an agent-format request the application would not send.
        await gateway.updateState({patient:{fields:{}},supporter:{fields:{}},user_goal:{},
          question_candidates:[],answered_count:0},null,{signal});
      }
      checks.push({...configuration,ok:true,mode:'synthetic_generation'});
    } catch(error) {
      checks.push({...configuration,ok:false,mode:'synthetic_generation',code:error.code||'MODEL_CHECK_FAILED',
        reason:error.modelReason||null});
    }
  }
  return {ok:checks.every(check=>check.ok),checks};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  const report=args.some(arg=>arg!=='--generate')||new Set(args).size!==args.length
    ?{ok:false,checks:[{role:'arguments',ok:false,code:'USE_OPTIONAL_GENERATE_ONLY'}]}
    :await checkModelConnections({generate:args.includes('--generate')});
  console.log(JSON.stringify(report));
  process.exitCode=report.ok?0:1;
}
