import {CUES,assessmentSchema,responseSchema,decidePolicy,RUBRIC_VERSION} from '../v2/assessment.ts';
import {V2Error} from '../v2/errors.ts';
import {SCHEMAS} from '../v2/model.ts';
import type {ModelContext} from '../v2/model.ts';

export const API_VERSION='1';
export const MAX_BODY_BYTES=262144;
export const PATHS={assess:'/v1/assessments',respond:'/v1/responses',extract:'/v1/tasks/extract',guide:'/v1/tasks/guide',verify:'/v1/tasks/verify',tokenize:'/v1/tokenize'} as const;
export type ModelOperation=keyof typeof PATHS;
export type ModelIdentity={model_id:string;checkpoint_sha256:string;prompt_profile:string;prompt_version:string};
export type ModelRequest={api_version:'1';request_id:string;expected_model:ModelIdentity;input:ModelContext};
export class ModelApiError extends V2Error {
  constructor(status:number,code:string){super(status,code,'모델 API 요청을 완료하지 못했습니다.');}
}
function invalid():never{throw new ModelApiError(422,'INVALID_MODEL_REQUEST');}
function object(value:any,allowed:string[],required=allowed){
  if(!value||typeof value!=='object'||Array.isArray(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!allowed.includes(key)))invalid();
}
function str(value:any,max:number,min=0){if(typeof value!=='string'||[...value].length<min||[...value].length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))invalid();}
function integer(value:any,min:number,max:number){if(!Number.isInteger(value)||value<min||value>max)invalid();}
const identifier=(value:any)=>{str(value,120,1);if(!/^[A-Za-z0-9_.:-]+$/.test(value))invalid();};
function list(value:any,max:number,check:(item:any,index:number)=>void){if(!Array.isArray(value)||value.length>max)invalid();value.forEach(check);}
export function validateIdentity(value:any):ModelIdentity{
  object(value,['model_id','checkpoint_sha256','prompt_profile','prompt_version']);str(value.model_id,200,1);
  if(!/^[a-f0-9]{64}$/i.test(value.checkpoint_sha256)||!['test','production'].includes(value.prompt_profile)||value.prompt_version!=='v1')invalid();
  return value;
}
export function sameIdentity(a:ModelIdentity,b:ModelIdentity){return a.model_id===b.model_id&&a.checkpoint_sha256.toLowerCase()===b.checkpoint_sha256.toLowerCase()&&a.prompt_profile===b.prompt_profile&&a.prompt_version===b.prompt_version;}
function target(value:any,assessment:boolean){
  const fields=assessment?['patient_id','project_id','conversation_id','speaker']:['patient_id','speaker'];object(value,fields);
  if(value.speaker!=='supporter')invalid();identifier(value.patient_id);
  if(assessment){identifier(value.project_id);identifier(value.conversation_id);if(value.patient_id!==value.project_id)invalid();}
}
function normalized(value:any){
  object(value,[...CUES]);
  for(const key of CUES){const cue=value[key];object(cue,['score','source','timeframe','evidence']);integer(cue.score,-1,3);integer(cue.source,0,3);integer(cue.timeframe,0,3);
    list(cue.evidence,2,ref=>{object(ref,['message_index','start_cp','end_cp','message_id']);integer(ref.message_index,0,5);integer(ref.start_cp,0,8000);integer(ref.end_cp,1,8000);if(ref.start_cp>=ref.end_cp)invalid();identifier(ref.message_id);});
    if(cue.score===-1?(cue.source!==0||cue.timeframe!==0||cue.evidence.length!==0):(cue.source!==2||cue.timeframe===0||!cue.evidence.length))invalid();
  }
}
function patientContext(value:any){
  object(value,['evaluation_status','current','previous_valid','trend','response_policy','assessment_available','rubric_version','model_sha256','prompt_version','do_not_diagnose']);
  integer(value.evaluation_status,0,3);normalized(value.current);
  const unknown=CUES.filter(key=>value.current[key].score<0).length;
  if((value.evaluation_status===0&&unknown!==0)||([1,3].includes(value.evaluation_status)&&unknown!==CUES.length)||(value.evaluation_status===2&&(unknown===0||unknown===CUES.length)))invalid();
  object(value.previous_valid,[...CUES]);object(value.trend,[...CUES]);
  for(const key of CUES){const previous=value.previous_valid[key],trend=value.trend[key];
    if(previous!==null){object(previous,['score','turn_id','created_at']);integer(previous.score,0,3);identifier(previous.turn_id);str(previous.created_at,40,1);if(!Number.isFinite(Date.parse(previous.created_at)))invalid();}
    object(trend,['comparable','delta']);if(typeof trend.comparable!=='boolean')invalid();
    if(trend.comparable){integer(trend.delta,-3,3);if(!previous||value.current[key].score<0||trend.delta!==value.current[key].score-previous.score)invalid();}else if(trend.delta!==null)invalid();
  }
  if(value.response_policy!==decidePolicy(value.current,value.evaluation_status)||value.assessment_available!==(value.evaluation_status!==3)||value.rubric_version!==RUBRIC_VERSION||value.do_not_diagnose!==true||!/^[a-f0-9]{64}$/i.test(value.model_sha256)||value.prompt_version!=='v1')invalid();
}
export function validateRequest(value:any,operation:ModelOperation):ModelRequest{
  object(value,['api_version','request_id','expected_model','input']);if(value.api_version!==API_VERSION)invalid();identifier(value.request_id);validateIdentity(value.expected_model);
  const input=value.input;
  if(operation==='tokenize'){object(input,['current_message']);str(input.current_message,60000);return value;}
  if(operation==='assess'){
    object(input,['current_message','target','messages','rubric_version']);str(input.current_message,8000);target(input.target,true);
    if(input.rubric_version!==RUBRIC_VERSION)invalid();
    list(input.messages,6,(message,index)=>{object(message,['message_index','content','speaker']);if(message.message_index!==index||message.speaker!=='supporter')invalid();str(message.content,8000);});
    if(!input.messages.length||input.messages.at(-1).content!==input.current_message)invalid();
  }else if(operation==='respond'){
    object(input,['current_message','target','recent_messages','patient_cue_context']);str(input.current_message,8000);target(input.target,false);
    list(input.recent_messages,6,message=>{object(message,['id','role','content']);identifier(message.id);if(!['user','assistant'].includes(message.role))invalid();str(message.content,8000);});
    patientContext(input.patient_cue_context);
    if(input.patient_cue_context.model_sha256.toLowerCase()!==value.expected_model.checkpoint_sha256.toLowerCase()||input.patient_cue_context.prompt_version!==value.expected_model.prompt_version)invalid();
  }else{
    object(input,['current_message','message_id','goal','answers','memories','recent_messages','knowledge','safety','draft','previous_draft','correction_requirements'],['current_message']);str(input.current_message,8000);
    for(const key of ['answers','memories','recent_messages','knowledge','safety','correction_requirements'])if(input[key]!==undefined&&!Array.isArray(input[key]))invalid();
  }
  return value;
}

const obj=(properties:Record<string,any>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,required,properties});
const ref=(name:string)=>({$ref:'#/components/schemas/'+name});
const idSchema={type:'string',minLength:1,maxLength:120,pattern:'^[A-Za-z0-9_.:-]+$'};
const contentSchema={type:'string',maxLength:8000};
const identitySchema=obj({model_id:{type:'string',minLength:1,maxLength:200},checkpoint_sha256:{type:'string',pattern:'^[a-fA-F0-9]{64}$'},prompt_profile:{type:'string',enum:['test','production']},prompt_version:{type:'string',enum:['v1']}});
const normalizedSchema:any=structuredClone(assessmentSchema);delete normalizedSchema.properties.schema_version;normalizedSchema.required=[...CUES];
for(const cue of CUES){normalizedSchema.properties[cue].properties.evidence.items.properties.message_id=idSchema;normalizedSchema.properties[cue].properties.evidence.items.required.push('message_id');}
const previousSchema={anyOf:[{type:'null'},obj({score:{type:'integer',minimum:0,maximum:3},turn_id:idSchema,created_at:{type:'string',format:'date-time'}})]};
const trendSchema={oneOf:[obj({comparable:{const:true},delta:{type:'integer',minimum:-3,maximum:3}}),obj({comparable:{const:false},delta:{type:'null'}})]};
const patientSchema=obj({evaluation_status:{type:'integer',enum:[0,1,2,3]},current:ref('NormalizedAssessment'),previous_valid:obj(Object.fromEntries(CUES.map(cue=>[cue,previousSchema]))),trend:obj(Object.fromEntries(CUES.map(cue=>[cue,trendSchema]))),response_policy:{enum:['ordinary','reflect_and_clarify','safety_support','assessment_unavailable']},assessment_available:{type:'boolean'},rubric_version:{const:RUBRIC_VERSION},model_sha256:identitySchema.properties.checkpoint_sha256,prompt_version:{const:'v1'},do_not_diagnose:{const:true}});
const inputSchemas:Record<ModelOperation,any>={
  assess:obj({current_message:contentSchema,target:obj({patient_id:idSchema,project_id:idSchema,conversation_id:idSchema,speaker:{const:'supporter'}}),messages:{type:'array',minItems:1,maxItems:6,items:obj({message_index:{type:'integer',minimum:0,maximum:5},content:contentSchema,speaker:{const:'supporter'}})},rubric_version:{const:RUBRIC_VERSION}}),
  respond:obj({current_message:contentSchema,target:obj({patient_id:idSchema,speaker:{const:'supporter'}}),recent_messages:{type:'array',maxItems:6,items:obj({id:idSchema,role:{enum:['user','assistant']},content:contentSchema})},patient_cue_context:ref('PatientCueContext')}),
  tokenize:obj({current_message:{type:'string',maxLength:60000}}),
  ...Object.fromEntries(['extract','guide','verify'].map(operation=>[operation,obj({current_message:contentSchema,message_id:idSchema,goal:{type:'string'},...Object.fromEntries(['answers','memories','recent_messages','knowledge','safety','correction_requirements'].map(key=>[key,{type:'array'}])),draft:{type:'object'},previous_draft:{type:'object'}},['current_message'])])),
} as Record<ModelOperation,any>;
const outputSchemas:Record<ModelOperation,any>={assess:assessmentSchema,respond:responseSchema,tokenize:obj({tokens:{type:'integer',minimum:0}}),extract:SCHEMAS.extract,guide:SCHEMAS.guide,verify:SCHEMAS.verify};
const schemas:Record<string,any>={Identity:identitySchema,NormalizedAssessment:normalizedSchema,PatientCueContext:patientSchema,Error:obj({api_version:{const:API_VERSION},request_id:{type:['string','null']},error:obj({code:{type:'string'},retryable:{type:'boolean'}})})};
for(const operation of Object.keys(PATHS) as ModelOperation[]){
  schemas[operation+'Input']=inputSchemas[operation];schemas[operation+'Output']=outputSchemas[operation];
  schemas[operation+'Request']=obj({api_version:{const:API_VERSION},request_id:idSchema,expected_model:ref('Identity'),input:ref(operation+'Input')});
  schemas[operation+'Result']=obj({api_version:{const:API_VERSION},request_id:idSchema,operation:{const:operation},model:ref('Identity'),output:ref(operation+'Output')});
}
const errorsByStatus={'401':'Invalid bearer token','403':'Browser access forbidden','409':'Model identity or idempotency conflict','413':'Request too large','415':'JSON required','422':'Invalid input','429':'Inference slot busy','499':'Caller cancelled','502':'Invalid model output','503':'Inference disabled or server unavailable','504':'Deadline exceeded'};
const errorResponses=Object.fromEntries(Object.entries(errorsByStatus).map(([status,description])=>[status,{description,content:{'application/json':{schema:ref('Error')}}}]));
const operationPaths=Object.entries(PATHS).map(([operation,path])=>[path,{
  post:{
    operationId:operation,
    summary:operation==='assess'?'B evaluation with numeric-only output':operation==='respond'?'A response using server-validated B context':operation,
    requestBody:{required:true,content:{'application/json':{schema:ref(operation+'Request')}}},
    responses:{
      '200':{description:'Validated output and configured checkpoint metadata',content:{'application/json':{schema:ref(operation+'Result')}}},
      ...errorResponses,
    },
  },
}]);
export const MODEL_API_OPENAPI={openapi:'3.1.0',info:{title:'Malssi server-to-server model I/O API',version:'1.0.0',description:'B and A use one configured checkpoint. No model, training, or worker is started by this API. Input is server-owned; browser access is not supported. Evidence offsets are Unicode code points.'},servers:[{url:'http://127.0.0.1:9010'}],security:[{modelBearer:[]}],paths:Object.fromEntries([
  ['/health/live',{get:{summary:'Process liveness; never invokes inference',responses:{'200':{description:'API process is running'}}}}],
  ['/v1/status',{get:{summary:'Configuration and model identity; inference readiness is not probed',responses:{'200':{description:'enabled/configured flags and configured model metadata'}}}}],
  ['/v1/openapi.json',{get:{summary:'This OpenAPI document',responses:{'200':{description:'OpenAPI 3.1 JSON'}}}}],
  ...operationPaths,
]),components:{securitySchemes:{modelBearer:{type:'http',scheme:'bearer'}},schemas}};
