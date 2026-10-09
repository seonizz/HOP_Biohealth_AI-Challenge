import {esc} from './ui.js';
const labels={relation:'그분은 나의',contact_frequency:'만나거나 연락하는 빈도'};
export function choiceMarkup(field,name,multi=false) {
  return `<div class="choices">${field.options.map(o=>`<label class="choice"><input type="${multi?'checkbox':'radio'}" name="${name}" value="${esc(o.id)}"><span>${esc(o.label)}</span></label>`).join('')}</div>`;
}
export function questionMarkup(q) {
  const schema=q.answer_schema,fields=schema.fields;
  let content='';
  if(schema.kind==='text')content=`<label class="field">답변<textarea name="text" rows="3" maxlength="${fields[0].max_codepoints*2}" placeholder="편하게 적어 주세요. 실명 대신 별칭을 써 주세요."></textarea><small>최대 ${fields[0].max_codepoints}자</small></label>`;
  else if(schema.kind==='composite')content=fields.map(f=>`<fieldset class="part"><legend>${esc(labels[f.id]||f.id)}</legend>${choiceMarkup(f,f.id)}<label class="field">직접 입력 또는 덧붙일 이야기<input name="${f.id}_detail" maxlength="1000"></label><label class="field">이 항목만 건너뛰기<select name="${f.id}_status"><option value="answered">답변할게요</option><option value="unknown">잘 모르겠어요</option><option value="skipped">건너뛸게요</option></select></label></fieldset>`).join('');
  else if(schema.kind==='coping_entries') {
    const s=fields[0].entry_schema;
    content=`<div id="coping-entries"><div class="coping-entry"><label class="field">해 본 방법<select name="method">${s.method_options.map(o=>`<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}</select></label><label class="field">어땠나요?<select name="effect">${s.effect_options.map(o=>`<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}</select></label><label class="field">덧붙일 이야기<input name="entry_detail" maxlength="1000"></label></div></div><button type="button" class="ghost" id="add-coping">방법 하나 더 추가</button><label class="field">또는 직접 적기<textarea name="direct" rows="2"></textarea></label>`;
  } else {
    const field=fields[0];content=choiceMarkup(field,'options',schema.kind==='multi_choice');
    content+='<label class="field">직접 입력을 골랐거나 더 할 이야기가 있어요<input name="detail" maxlength="1000"></label>';
    if(field.allow_direct_text)content+='<label class="field">또는 보기 대신 직접 적기<textarea name="direct" rows="2"></textarea></label>';
  }
  return `<form id="answer-form"><fieldset class="form-body">${content}<p class="form-error" role="alert" id="answer-error"></p><div class="actions"><button class="btn" type="submit">답변 보내기</button>${q.disposition_options.includes('unknown')?'<button class="ghost disposition" data-value="unknown" type="button">잘 모르겠어요</button>':''}${q.disposition_options.includes('skipped')?'<button class="ghost disposition" data-value="skipped" type="button">건너뛰기</button>':''}</div></fieldset></form>`;
}
function text(value,max=2000,required=true) {
  const result=String(value||'').normalize('NFC').trim();
  if(required&&!result)throw new Error('답변을 입력해 주세요.');
  if([...result].length>max)throw new Error(`${max}자 이내로 적어 주세요.`);
  return result;
}
export function serializeAnswer(q,data) {
  const {kind,fields}=q.answer_schema;
  if(kind==='text')return {text:text(data.get('text'),fields[0].max_codepoints)};
  if(kind==='composite') {
    const result=Object.fromEntries(fields.map(f=>{
      const status=data.get(f.id+'_status')||'answered';
      if(status!=='answered')return [f.id,{status}];
      const option_id=data.get(f.id),detail=text(data.get(f.id+'_detail'),500,false);
      if(!option_id) {if(detail)return [f.id,{status,text:detail}];throw new Error(`${labels[f.id]} 항목을 선택해 주세요.`);}
      if(option_id==='other'&&!detail)throw new Error('직접 입력한 내용을 적어 주세요.');
      return [f.id,{status,option_id,...(detail?{detail}:{})}];
    }));
    if(!Object.values(result).some(v=>v.status==='answered'))throw new Error('한 항목 이상 답하거나 아래 건너뛰기 버튼을 눌러 주세요.');
    return result;
  }
  const direct=data.get('direct');
  if(direct?.trim())return {text:text(direct,fields[0].direct_text_max_codepoints||2000)};
  if(kind==='coping_entries') {
    const methods=data.getAll('method'),effects=data.getAll('effect'),details=data.getAll('entry_detail');
    return {entries:methods.map((method_option_id,i)=>{const detail=text(details[i],500,method_option_id==='other');return {method_option_id,effect_option_id:effects[i],...(detail?{detail}:{})};})};
  }
  const f=fields[0],option_ids=data.getAll('options'),detail=text(data.get('detail'),500,false);
  if(option_ids.length<f.min_selected||option_ids.length>f.max_selected)throw new Error(`${f.min_selected}~${f.max_selected}개를 골라 주세요.`);
  if(option_ids.length>1&&option_ids.some(x=>f.mutually_exclusive_option_ids?.includes(x)))throw new Error('“없음” 등 단독 보기는 다른 보기와 함께 고를 수 없어요.');
  if(option_ids.includes('other')&&!detail)throw new Error('직접 입력한 내용을 적어 주세요.');
  return {option_ids,...(detail?{detail}:{})};
}
export function bindQuestion(form,q,submit) {
  form.onsubmit=(event)=>{event.preventDefault();try{submit('answered',serializeAnswer(q,new FormData(form)));}catch(error){form.querySelector('#answer-error').textContent=error.message;}};
  form.querySelectorAll('.disposition').forEach(b=>b.onclick=()=>submit(b.dataset.value,null));
  form.querySelectorAll('input[name="options"]').forEach(input=>input.onchange=()=>{
    const exclusive=q.answer_schema.fields[0].mutually_exclusive_option_ids||[];
    if(input.checked)form.querySelectorAll('input[name="options"]').forEach(other=>{if(other!==input&&(exclusive.includes(input.value)||exclusive.includes(other.value)))other.checked=false;});
  });
  const add=form.querySelector('#add-coping');
  if(add)add.onclick=()=>{const rows=form.querySelector('#coping-entries');const clone=rows.firstElementChild.cloneNode(true);clone.querySelector('input').value='';const remove=document.createElement('button');remove.type='button';remove.className='ghost';remove.textContent='이 방법 삭제';remove.onclick=()=>{clone.remove();add.disabled=false;};clone.append(remove);rows.append(clone);add.disabled=rows.children.length>=q.answer_schema.fields[0].max_items;};
}
export function answerText(answer,q) {
  if(answer.disposition!=='answered')return {unknown:'잘 모르겠어요',skipped:'건너뛰었어요',not_applicable:'해당하지 않아요'}[answer.disposition]||'';
  const value=answer.value;if(!value)return '';
  if(value.text)return value.text;
  const fields=q?.answer_schema?.fields||[];
  const label=(id,options)=>options?.find(o=>o.id===id)?.label||id;
  if(value.option_ids)return value.option_ids.map(id=>label(id,fields[0]?.options)).join(', ')+(value.detail?' · '+value.detail:'');
  if(value.entries)return value.entries.map(e=>`${label(e.method_option_id,fields[0]?.entry_schema?.method_options)}: ${label(e.effect_option_id,fields[0]?.entry_schema?.effect_options)}${e.detail?' · '+e.detail:''}`).join('\n');
  return fields.map(f=>{const v=value[f.id];return `${labels[f.id]||f.id}: ${v?.text||label(v?.option_id,f.options)||({unknown:'모름',skipped:'건너뜀'}[v?.status])||''}${v?.detail?' · '+v.detail:''}`;}).join('\n');
}
