export type Goal='understand'|'what_to_say'|'what_to_do'|'support_me'|'find_help'|'unsure';
export type Disposition='answered'|'unknown'|'skipped'|'not_applicable';
export type ConversationState='SETUP'|'EXPLORING'|'REVIEWING'|'GUIDANCE'|'FOLLOW_UP'|'SAFETY_HOLD'|'COMPLETED'|'ARCHIVED';
export type RunStatus='ACCEPTED'|'RUNNING'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'SUPERSEDED';
export type AnswerValue={text:string}|{option_ids:string[];detail?:string}|{relation:{status:Disposition;option_id?:string;detail?:string};contact_frequency:{status:Disposition;option_id?:string;detail?:string};detail?:string}|{entries:{method_option_id:string;effect_option_id:string;detail?:string}[]}|null;
export type TurnAction=
 |{action:'answer';payload:{question_instance_id:string;question_id:string;question_version:string;disposition:Disposition;value:AnswerValue}}
 |{action:'message';payload:{text:string}}
 |{action:'select_topic';payload:{topic_id:string}}
 |{action:'select_question';payload:{question_id:string}}
 |{action:'request_guidance';payload:{guidance_kind:Goal|'communication_guidance'}}
 |{action:'correct_answer';payload:{answer_revision_id:string;replacement:{disposition:Disposition;value:AnswerValue}}}
 |{action:'confirm_summary';payload:{summary_id:string;accepted_memory_ids:string[]}}
 |{action:'safety_update';payload:{safety_episode_id?:string;text:string}}
 |{action:'resume_after_safety';payload:{safety_episode_id:string;acknowledgement:'no_current_immediate_danger';text:string}}
 |{action:'finish';payload:{reason?:string}}
 |{action:'archive'|'restore';payload:Record<string,never>};
export type TurnRequest=TurnAction&{request_id:string;expected_revision:number};
export interface WriteResult {schema_version:'2.0';request_id:string;saved:boolean;resource_revision:number;next_actions:string[];conversation_id?:string;project_id?:string;memory_id?:string;run_id?:string|null;deletion_id?:string;}
export interface Run {id:string;status:RunStatus;input_saved:true;result:Record<string,unknown>|null;error:{code:string;retryable:boolean}|null;}
export class MalssiApiError extends Error {readonly status:number;readonly body:any;constructor(status:number,body:any){super(body.error?.message||'요청을 처리하지 못했습니다.');this.status=status;this.body=body;}}
export class MalssiClient {
 readonly base:string;readonly token?:string;
 constructor(base='',token?:string){this.base=base.replace(/\/$/,'');this.token=token;}
 async request<T>(path:string,method='GET',body?:unknown):Promise<T>{
   const response=await fetch(this.base+'/api/v2'+path,{method,credentials:'include',headers:{...(body?{'Content-Type':'application/json'}:{}),...(this.token?{Authorization:'Bearer '+this.token}:{})},...(body?{body:JSON.stringify(body)}:{})});
   const value=await response.json();if(!response.ok)throw new MalssiApiError(response.status,value);return value as T;
 }
 turn(conversation:string,input:TurnRequest){return this.request<WriteResult>('/conversations/'+encodeURIComponent(conversation)+'/turns','POST',input);}
 run(id:string){return this.request<Run>('/runs/'+encodeURIComponent(id));}
 conversations(project:string,cursor?:string){return this.request<{conversations:{conversation_id:string;resource_revision:number;state:ConversationState;goal:Goal;created_at:string}[];next_cursor:string|null}>('/projects/'+encodeURIComponent(project)+'/conversations'+(cursor?'?cursor='+encodeURIComponent(cursor):''));}
 cancel(id:string,request_id:string){return this.request<WriteResult>('/runs/'+encodeURIComponent(id)+'/cancel','POST',{request_id});}
 // Cookie-authenticated browser SSE. Never place a Bearer token in its URL.
 events(id:string){if(this.token)throw new Error('Use an authenticated fetch SSE client for Bearer authentication');return new EventSource(this.base+'/api/v2/conversations/'+encodeURIComponent(id)+'/events',{withCredentials:true});}
}
