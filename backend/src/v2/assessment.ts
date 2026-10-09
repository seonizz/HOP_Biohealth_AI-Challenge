import {readFileSync} from 'node:fs';
import {fail} from './errors.ts';

export const assessmentSchema=JSON.parse(readFileSync(new URL('../../docs/dual-model/assessment.schema.json',import.meta.url),'utf8'));
export const responseSchema=JSON.parse(readFileSync(new URL('../../docs/dual-model/response.schema.json',import.meta.url),'utf8'));
export const CUES=['sadness','anxiety','agitation','self_harm_cue','harm_to_others_cue','acute_danger_cue'] as const;
export type Cue=typeof CUES[number];
export type EvidenceMessage={id:string;content:string;speaker:'supporter'};
export type Assessment=Record<Cue,{score:number;source:number;timeframe:number;evidence:{message_index:number;start_cp:number;end_cp:number;message_id:string}[]}>;
export const RUBRIC_VERSION='patient-cues-v1';

function checkShape(value:any,schema:any):void {
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_MODEL_OUTPUT');
    const fields=Object.keys(value),required=schema.required||[];
    if(required.some((key:string)=>!Object.hasOwn(value,key))||schema.additionalProperties===false&&fields.some(key=>!Object.hasOwn(schema.properties,key)))fail('INVALID_MODEL_OUTPUT');
    for(const key of fields)checkShape(value[key],schema.properties[key]);
  }else if(schema.type==='array'){
    if(!Array.isArray(value)||schema.maxItems!==undefined&&value.length>schema.maxItems||schema.minItems!==undefined&&value.length<schema.minItems)fail('INVALID_MODEL_OUTPUT');
    value.forEach(item=>checkShape(item,schema.items));
  }else if(schema.type==='integer'){
    if(!Number.isInteger(value)||schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum)fail('INVALID_MODEL_OUTPUT');
  }else if(schema.type==='string'){
    if(typeof value!=='string'||schema.minLength!==undefined&&[...value].length<schema.minLength||schema.maxLength!==undefined&&[...value].length>schema.maxLength)fail('INVALID_MODEL_OUTPUT');
  }else fail('INVALID_MODEL_OUTPUT');
  if(schema.enum&&!schema.enum.includes(value))fail('INVALID_MODEL_OUTPUT');
}
export function unknownAssessment():Assessment {
  return Object.fromEntries(CUES.map(key=>[key,{score:-1,source:0,timeframe:0,evidence:[]}])) as unknown as Assessment;
}
const PATIENT=/그분|환자|친구|가족|어머니|아버지|엄마|아빠|남편|아내|배우자|동생|언니|오빠|형|누나|아이|자녀|아들|딸|<SUBJECT>/u;
const CAREGIVER_SELF=/(?:제가|저는|내가|나는|제 마음|내 마음).{0,20}(?:불안|걱정|우울|슬픔|초조|힘들|자해|죽고)/u;
const HYPOTHETICAL=/만약|가정|예시|소설|영화|상상|했다면/u;
const PAST_ONLY=/예전|과거|작년|지난해|한때|옛날/u;
const NEGATED=/없|않|아니|안\s|괜찮/u;
const cueWords:Record<Cue,RegExp>={sadness:/우울|슬프|힘들|무기력|가라앉/u,anxiety:/불안|걱정|공황|두렵|무섭/u,agitation:/초조|안절부절|불안정|들떠|흥분/u,self_harm_cue:/자해|자살|죽고|해치/u,harm_to_others_cue:/폭력|때리|해치|죽이/u,acute_danger_cue:/위험|쓰러|의식|피|다치|응급|119/u};
export function validateAssessment(raw:any,messages:EvidenceMessage[]):Assessment {
  checkShape(raw,assessmentSchema);
  const output=unknownAssessment();
  for(const key of CUES){
    const cue=raw[key],evidence=[] as Assessment[Cue]['evidence'];
    if(cue.score===-1){if(cue.source!==0||cue.timeframe!==0||cue.evidence.length!==0)fail('INVALID_MODEL_OUTPUT');continue;}
    if(cue.source!==2||cue.evidence.length<1||cue.timeframe===0)fail('INVALID_MODEL_OUTPUT');
    for(const ref of cue.evidence){
      const message=messages[ref.message_index],points=message?[...message.content]:[];
      if(!message||message.speaker!=='supporter'||ref.start_cp>=ref.end_cp||ref.end_cp>points.length)fail('INVALID_MODEL_OUTPUT');
      const quote=points.slice(ref.start_cp,ref.end_cp).join('');
      if(!PATIENT.test(quote)||CAREGIVER_SELF.test(quote)||!cueWords[key].test(quote))fail('INVALID_MODEL_OUTPUT');
      if(cue.score===0&&!NEGATED.test(quote))fail('INVALID_MODEL_OUTPUT');
      if(cue.timeframe===1&&(HYPOTHETICAL.test(quote)||PAST_ONLY.test(quote))&&!/지금|현재|요즘|최근/u.test(quote))fail('INVALID_MODEL_OUTPUT');
      if(cue.timeframe===3&&cue.score>0)fail('INVALID_MODEL_OUTPUT');
      if(key.endsWith('_cue')&&cue.score>=2&&(cue.timeframe!==1||NEGATED.test(quote)))fail('INVALID_MODEL_OUTPUT');
      evidence.push({...ref,message_id:message.id});
    }
    output[key]={score:cue.score,source:cue.source,timeframe:cue.timeframe,evidence};
  }
  return output;
}
export function validateResponse(raw:any):{message:string}{
  checkShape(raw,responseSchema);
  const message=raw.message.trim();
  if(!message||/<(?:script|iframe)|\b(?:system|assistant):/iu.test(message))fail('INVALID_MODEL_OUTPUT');
  // Keep the same deterministic safety boundary used by the existing guidance path.
  if(/\b\d{2,4}[- ]?\d{3,4}[- ]?\d{4}\b|\b(?:112|119|109|1393)\b|https?:\/\//u.test(message)
    ||/약(?:을|은)?.{0,12}(?:끊으|중단하|늘리|줄이|복용량)|(?:우울증|불안장애|중독)(?:입니다|이\s*확실)|반드시\s*(?:설득|제압)/u.test(message))fail('FAILED_VERIFICATION');
  return {message};
}
export type HistoryEntry={turn_id:string;status:number;model_sha256:string;prompt_version:string;rubric_version:string;normalized:Assessment;created_at:string};
export function comparison(current:Assessment,history:HistoryEntry[],modelHash:string,promptVersion:string){
  const previous:any={},trend:any={};
  for(const key of CUES){
    const now=current[key];
    const prior=history.find(item=>item.status!==3&&item.model_sha256===modelHash&&item.prompt_version===promptVersion&&item.rubric_version===RUBRIC_VERSION&&item.normalized[key]?.score>=0&&item.normalized[key].source===now.source&&item.normalized[key].timeframe===now.timeframe);
    previous[key]=prior?{score:prior.normalized[key].score,turn_id:prior.turn_id,created_at:prior.created_at}:null;
    trend[key]=prior&&now.score>=0?{comparable:true,delta:now.score-prior.normalized[key].score}:{comparable:false,delta:null};
  }
  return {previous_valid:previous,trend};
}
export type Thresholds={version:string;emotionAbsolute:number;emotionDelta:number;riskAbsolute:number;riskDelta:number};
const threshold=(name:string,defaultValue:number)=>{const n=Number(process.env[name]??defaultValue);if(!Number.isInteger(n)||n<0||n>3)throw new Error(`Invalid ${name}`);return n;};
export function thresholds():Thresholds{return {version:process.env.HOP_DUAL_THRESHOLD_VERSION||'draft-v1',emotionAbsolute:threshold('HOP_DUAL_EMOTION_ABSOLUTE',3),emotionDelta:threshold('HOP_DUAL_EMOTION_DELTA',2),riskAbsolute:threshold('HOP_DUAL_RISK_ABSOLUTE',2),riskDelta:threshold('HOP_DUAL_RISK_DELTA',1)};}
export function decidePolicy(assessment:Assessment,status:number){
  if(status===3)return 'assessment_unavailable';
  if(CUES.slice(3).some(key=>assessment[key].timeframe===1&&assessment[key].score>=2))return 'safety_support';
  if(CUES.slice(0,3).some(key=>assessment[key].timeframe===1&&assessment[key].score>=2))return 'reflect_and_clarify';
  return 'ordinary';
}
export function decideAlerts(assessment:Assessment,trend:any,status:number,settings:Thresholds):string[]{
  if(status===3)return ['assessment_unavailable'];
  const alerts:string[]=[];
  for(const key of CUES){const cue=assessment[key],change=trend[key];if(cue.score<0||cue.timeframe!==1)continue;
    const risk=key.endsWith('_cue');
    if(cue.score>=(risk?settings.riskAbsolute:settings.emotionAbsolute))alerts.push(`${key}_absolute`);
    else if(change.comparable&&change.delta>=(risk?settings.riskDelta:settings.emotionDelta))alerts.push(`${key}_increase`);
  }
  return alerts;
}
