import {ModelGateway} from './model.js';
import {HttpError,object} from './errors.js';

export const DEFAULT_MODEL_EXECUTION=Object.freeze({question_mode:'single',scheduling:'individual',question_source:'general',review_source:'general'});
const invalid=()=>new HttpError(422,'INVALID_MODEL_EXECUTION','질문 호출 방식과 질문용·검토용 모델 설정을 확인해 주세요.');
export function validateModelExecution(value){
  try {
    object(value,Object.keys(DEFAULT_MODEL_EXECUTION));
    for(const [key,allowed] of Object.entries({question_mode:['single','two','individual'],scheduling:['individual','parallel'],
      question_source:['general','custom'],review_source:['general','custom']}))if(!allowed.includes(value[key]))throw invalid();
    return {...value};
  }catch{throw invalid();}
}

// Final cards and continuations keep the original general gateway. Only the
// question entry point delegates to this immutable, per-conversation policy.
export function attachQuestionExecution(general,execution){
  const settings=validateModelExecution(execution.settings);
  if(general.protocol!=='relationship_agent')throw invalid();
  const base=Object.fromEntries(Object.entries(general).filter(([key,value])=>key!=='reviewedNameIdentity'&&['string','number','boolean'].includes(typeof value)));
  const selected=source=>source==='general'?base:null;
  const question=selected(settings.question_source)||execution.question;
  const review=selected(settings.review_source)||execution.review;
  if(!question||!review)throw invalid();
  const common={protocol:'relationship_agent',stateMode:'combined',singleCallTurns:false,singleCallQuestionOnly:false,
    bundleCombinedTurnReviews:false,bundleTurnReviews:false,reuseReviewedName:false,reuseReviewedSafety:false,questionCallLimit:0,reviewGateway:null,
    diagnosticLogger:general.diagnosticLogger,fetchImpl:general.fetchImpl};
  const reviewer=new ModelGateway({...review,...common});
  const mode=settings.question_mode;
  const gateway=new ModelGateway({...question,...common,
    stateMode:mode==='individual'?'combined_blocks':'combined',
    singleCallTurns:mode==='single',singleCallQuestionOnly:mode==='single',
    bundleCombinedTurnReviews:mode==='two',
    questionCallLimit:mode==='single'?1:mode==='two'?2:0,
    questionExecution:settings.scheduling,
    retryFailures:mode==='individual'&&question.retryFailures===true,
    reviewGateway:mode==='single'?null:reviewer});
  if(!gateway.configured||!reviewer.configured)throw invalid();
  general.questionGateway=gateway;
  general.executionSnapshot=structuredClone({...execution,settings});
  return general;
}

export function executionMetadata(id,gateway){
  const saved=gateway?.executionSnapshot;
  const connection=value=>value?{base_url:value.baseUrl,model:value.model,api_key_configured:Boolean(value.apiKey)}:null;
  return {id,...(saved?.settings||DEFAULT_MODEL_EXECUTION),question_connection:connection(saved?.question),
    review_connection:connection(saved?.review),configured:Boolean(saved&&gateway?.questionGateway?.configured)};
}
