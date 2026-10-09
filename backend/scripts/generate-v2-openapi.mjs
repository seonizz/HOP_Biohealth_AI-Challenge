import {writeFileSync} from 'node:fs';
const ref=name=>({$ref:'#/components/schemas/'+name});
const id={type:'string',format:'uuid'},str={type:'string',minLength:1},integer={type:'integer',minimum:0};
const obj=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const request=(properties,required=Object.keys(properties))=>obj({request_id:id,...properties},['request_id',...required]);
const actionPayloads={
 answer:obj({question_instance_id:id,question_id:str,question_version:str,disposition:{enum:['answered','unknown','skipped','not_applicable']},value:{oneOf:[{type:'null'},{type:'object',description:'The versioned catalog answer_schema controls fields, choices and code point limits.'}]}}),
 message:obj({text:{...str,maxLength:8000}}),select_topic:obj({topic_id:{enum:['A','B','C','D','E','F','SUPPORTER']}}),select_question:obj({question_id:str}),request_guidance:obj({guidance_kind:{enum:['communication_guidance','understand','what_to_say','what_to_do','support_me','find_help','unsure']}}),
 correct_answer:obj({answer_revision_id:id,replacement:obj({disposition:str,value:{type:['object','null']}})}),confirm_summary:obj({summary_id:id,accepted_memory_ids:{type:'array',uniqueItems:true,items:id}}),
 safety_update:obj({safety_episode_id:id,text:str},['text']),resume_after_safety:obj({safety_episode_id:id,acknowledgement:{const:'no_current_immediate_danger'},text:str}),finish:obj({reason:str},[]),archive:obj({}),restore:obj({})
};
const schemas={
 Error:obj({error:obj({code:str,message:str,retryable:{type:'boolean'},field_errors:{type:'array'},request_id:{type:['string','null']},trace_id:id}),input_saved:{type:['boolean','null']},run_id:{type:['string','null']},current_revision:{type:['integer','null']}},['error','input_saved','run_id']),
 WriteResult:{type:'object',required:['schema_version','request_id','saved','next_actions'],properties:{schema_version:{const:'2.0'},request_id:id,saved:{type:'boolean'},resource_revision:integer,next_actions:{type:'array',items:str},project_id:id,conversation_id:id,run_id:{type:['string','null']},memory_id:id,deletion_id:id}},
 Turn:{oneOf:Object.entries(actionPayloads).map(([action,payload])=>request({expected_revision:integer,action:{const:action},payload})),discriminator:{propertyName:'action'}},
 Consents:request({version:{const:'malssi-consent-v1'},purposes:obj(Object.fromEntries(['service_processing','sensitive_processing','history_storage','cross_session_memory'].map(p=>[p,{type:'boolean'}])))}),
 Withdraw:request({purposes:{type:'array',minItems:1,uniqueItems:true,items:{enum:['service_processing','sensitive_processing','history_storage','cross_session_memory']}}}),
 ProjectCreate:request({alias:{...str,maxLength:30},title:{...str,maxLength:80}},[]),ProjectPatch:request({expected_revision:integer,alias:{...str,maxLength:30},title:{...str,maxLength:80}},['expected_revision']),
 ConversationCreate:request({goal:{enum:['understand','what_to_say','what_to_do','support_me','find_help','unsure']},questionnaire_version:str},['goal']),
 Revision:request({expected_revision:integer}),Request:request({}),MemoryPatch:request({expected_revision:integer,corrected_value:{...str,maxLength:2000}}),MemoryDelete:request({expected_revision:integer,scope:{const:'forget_memory'}}),SourceDelete:request({expected_revision:integer,scope:{const:'delete_source'}}),
 Plan:request({guidance_id:id,action_index:integer,user_edited_text:{...str,maxLength:500}},['guidance_id']),
 Feedback:request({expected_revision:integer,status:{enum:['tried','paused','completed','discarded']},reported_outcome:{enum:['helpful','unhelpful','mixed','unknown','not_tried']},burden_change:{enum:['increased','decreased','same','unknown']},notes:{...str,maxLength:2000}},['expected_revision','status','reported_outcome','burden_change']),
 AccountDelete:request({current_password:str}),
 Run:{type:'object',required:['id','status','input_saved','result','error'],properties:{id,status:{enum:['ACCEPTED','RUNNING','SUCCEEDED','FAILED','CANCELLED','SUPERSEDED']},input_saved:{const:true},result:{type:['object','null']},error:{type:['object','null']}}}
};
const paths={};
function route(method,path,summary,schema,success=200){
 const op={summary,operationId:method+'_'+path.replaceAll(/[^a-zA-Z0-9]/g,'_'),security:[{bearerAuth:[]},{cookieAuth:[]}],parameters:[...path.matchAll(/\{([^}]+)\}/g)].map(([,name])=>({in:'path',name,required:true,schema:name==='version'?str:id})),responses:{[success]:{description:'Success',content:{'application/json':{schema:ref(path.includes('/runs/{id}')&&method==='get'?'Run':schema?'WriteResult':'Response')}}}}};
 if(schema)op.requestBody={required:true,content:{'application/json':{schema:ref(schema)}}};
 for(const status of [400,401,403,404,409,410,413,415,422,429,503])op.responses[status]={description:'Structured error',content:{'application/json':{schema:ref('Error')}}};
 (paths[path]??={})[method]=op;
}
schemas.Response={type:'object',description:'Versioned resource snapshot; see client/v2.ts and MALSSI_IMPLEMENTATION.md for fields.'};
for(const [path,summary] of [['capabilities','Feature availability'],['consents','Current consent purposes'],['projects','Owned projects'],['projects/{id}','Project'],['conversations/{id}','Conversation snapshot and question'],['conversations/{id}/messages','Messages in sequence order'],['runs/{id}','Saved input and run outcome'],['projects/{id}/memories','Memories, provenance and freshness'],['questionnaires/{version}','Immutable catalog'],['resources','Approved regional resources'],['deletions/{id}','Online and backup deletion state']])route('get','/api/v2/'+path,summary);
for(const [path,schema,status] of [['consents','Consents',201],['consents/withdraw','Withdraw',202],['projects','ProjectCreate',201],['projects/{id}/conversations','ConversationCreate',201],['conversations/{id}/turns','Turn',200],['runs/{id}/cancel','Request',200],['memories/{id}/confirm','Revision',200],['conversations/{id}/plans','Plan',201],['plans/{id}/feedback','Feedback',201]])route('post','/api/v2/'+path,path,schema,status);
route('patch','/api/v2/projects/{id}','Update display metadata','ProjectPatch');route('patch','/api/v2/memories/{id}','Correct remembered report','MemoryPatch');
for(const [path,schema] of [['projects/{id}','Revision'],['memories/{id}','MemoryDelete'],['messages/{id}','SourceDelete'],['account','AccountDelete']])route('delete','/api/v2/'+path,path,schema,202);
paths['/api/v2/conversations/{id}/turns'].post.responses[202]={description:'Input committed; model run accepted',content:{'application/json':{schema:ref('WriteResult')}}};
route('get','/api/v2/conversations/{id}/events','Authenticated SSE; references only, never draft tokens');
paths['/api/v2/conversations/{id}/events'].get.responses[200]={description:'15 second heartbeat; ordered events; replay with Last-Event-ID; snapshot_required after retention gap',content:{'text/event-stream':{schema:{type:'string'}}}};
paths['/api/v2/conversations/{id}/events'].get.parameters.push({in:'header',name:'Last-Event-ID',schema:{type:'string',pattern:'^[0-9]+$'}});
writeFileSync(new URL('../openapi-v2.json',import.meta.url),JSON.stringify({openapi:'3.1.0',info:{title:'말씨 backend v2',version:'2.0.0',description:'Internal implementation. Draft catalog and clinical/content review do not imply release approval. v1 remains in openapi.json.'},paths,components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'},cookieAuth:{type:'apiKey',in:'cookie',name:'hop_session'}},schemas}},null,2)+'\n');
