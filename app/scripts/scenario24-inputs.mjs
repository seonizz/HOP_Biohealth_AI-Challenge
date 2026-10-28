// Local synthetic questionnaire adapter. No model, HTTP or process operations.
import {readFile, realpath} from 'node:fs/promises';
import {resolve, relative, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const SCENARIO24_FIELDS = Object.freeze(['name','relationship','contact','symptoms','onset','recent_frequency',
  'summary','concern','has_event','events','interpretation','supports','burdens','background','influence','coping',
  'help_received','help_barriers','needs','others_advice','supporter_moment','supporter_frequency','supporter_emotion',
  'supporter_changes','supporter_extra','supporter_coping','supporter_supports','message','message_goals']);
const META = ['schema_version','synthetic','usage','id','title','focus','extras'];
const CONTROLS = new Set(['직접 입력','기타(직접 입력)']);
const CHOICES = {relationship:'rel',contact:'contact',onset:'dur',recent_frequency:'freq',events:'events',
  help_received:'help',help_barriers:'barrier',supporter_frequency:'moment_freq',supporter_changes:'cgchange',
  supporter_supports:'mysupport',message_goals:'goal'};
const SINGLE = new Set(['relationship','contact','onset','recent_frequency','supporter_frequency']);
const TEXT = {name:'name',message:'want',summary:'describe',concern:'concern',interpretation:'others_why',
  background:'values',influence:'values_effect',needs:'need',others_advice:'others_help',
  supporter_moment:'moment',supporter_emotion:'feeling',supporter_coping:'mycoping'};
const sha = value => createHash('sha256').update(value).digest('hex');
const hashValue = value => sha(JSON.stringify(value));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 10000;
function check(condition, suffix) {
  if (!condition) throw Object.assign(new Error('SCENARIO24_' + suffix), {code:'SCENARIO24_' + suffix});
}
function exactKeys(value, keys, suffix) {
  check(plain(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), suffix);
}
function freeze(value) {
  if (value && typeof value === 'object') {Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}

export function buildScenario24Plan(row, options, sourceHashes = {}) {
  exactKeys(row, [...SCENARIO24_FIELDS,...META], 'ROW_FIELDS');
  check(row.synthetic === true && Number.isInteger(row.id) && row.id >= 3 && row.id <= 26, 'CASE_ID');
  for (const key of ['schema_version','usage','title','focus']) check(text(row[key]), 'METADATA');
  exactKeys(options, [...Object.keys(CHOICES),'symptoms'], 'OPTION_FIELDS');
  for (const values of Object.values(options)) check(Array.isArray(values) && values.length > 0 &&
    values.every(text) && new Set(values).size === values.length, 'OPTION_DICTIONARY');
  check(plain(row.extras) && Object.keys(row.extras).every(key => Object.hasOwn(CHOICES,key)), 'EXTRA_FIELDS');
  check(plain(sourceHashes) && Object.values(sourceHashes).every(value => /^[a-f0-9]{64}$/.test(value)), 'SOURCE_HASHES');
  const answers = {}, coverage = {}, extras = [];
  const cover = (field,target,encoding,expected = true) => {
    check(!coverage[field], 'DUPLICATE_SOURCE_MAPPING');
    coverage[field] = {field,target,encoding,expected_submission:expected,value_sha256:hashValue(row[field])};
  };
  for (const [field,target] of Object.entries(TEXT)) {
    check(text(row[field]), 'TEXT_SOURCE');
    answers[target] = {type:'text',kind:'text',text:row[field],fields:[field],expected:true};
    cover(field,target,'verbatim_text');
  }
  for (const [field,target] of Object.entries(CHOICES)) {
    const selected = SINGLE.has(field) ? [row[field]] : row[field];
    check(Array.isArray(selected) && selected.every(value => options[field].includes(value)) &&
      new Set(selected).size === selected.length && (field === 'events' || selected.length > 0), 'SOURCE_SELECTION');
    const controls = selected.filter(value => CONTROLS.has(value));
    check(controls.length <= 1 && Object.hasOwn(row.extras,field) === (controls.length === 1), 'CUSTOM_CONTROL');
    const customParts = [];
    if (controls.length) {
      check(text(row.extras[field]), 'CUSTOM_SOURCE');
      customParts.push({field:'extras.'+field,text:row.extras[field]});
      extras.push({field:'extras.'+field,target,encoding:'verbatim_custom',value_sha256:hashValue(row.extras[field])});
    }
    const expected = field !== 'events' || row.has_event === true;
    answers[target] = {type:SINGLE.has(field)?'one':'multi',kind:'choice',labels:selected.filter(value => !CONTROLS.has(value)),
      customParts,fields:[field,...customParts.map(part => part.field)],expected};
    cover(field,target,'labels_from_dictionary_and_verbatim_custom',expected);
  }
  check(typeof row.has_event === 'boolean' && (row.events.length > 0) === row.has_event, 'EVENT_CONDITION');
  answers.cause = {type:'one',kind:'choice',labels:[row.has_event?'네':'아니요'],customParts:[],fields:['has_event'],expected:true};
  cover('has_event','cause','explicit_yes_no');
  check(Array.isArray(row.symptoms) && row.symptoms.length > 0 && new Set(row.symptoms).size === row.symptoms.length &&
    row.symptoms.every(index => Number.isInteger(index) && index >= 1 && index <= options.symptoms.length), 'SYMPTOM_IDS');
  answers.mood = {type:'multi',kind:'choice',labels:[...row.symptoms].sort((a,b)=>a-b).map(index => options.symptoms[index-1]),
    customParts:[],fields:['symptoms'],expected:true};
  cover('symptoms','mood','one_based_dictionary_ids_to_exact_labels');
  for (const [field,target] of [['supports','support'],['burdens','burden']]) {
    check(row[field] === null || text(row[field]), 'YES_NO_SOURCE');
    answers[target] = {type:'one',kind:row[field] === null?'choice':'detail',labels:[row[field] === null?'아니요':'네'],
      customParts:[],...(row[field] === null?{}:{detail:row[field]}),fields:[field],expected:true};
    cover(field,target,row[field] === null?'explicit_negative_not_missing':'verbatim_yes_detail');
  }
  check(text(row.coping), 'COPING_SOURCE');
  // Current service merged coping into help. Keep both source strings intact;
  // the newline is a separator, not generated respondent content.
  answers.help.customParts.unshift({field:'coping',text:row.coping});
  answers.help.fields.unshift('coping');
  cover('coping','help','verbatim_custom_before_help_extra');
  check(row.supporter_extra === null || text(row.supporter_extra), 'SUPPORTER_EXTRA_SOURCE');
  const noChange = row.supporter_changes.includes('특별한 변화는 없어요');
  check(!noChange || row.supporter_changes.length === 1 && row.supporter_extra === null, 'CHANGE_CONDITION');
  answers.cgchange_more = {type:'text',kind:'text',text:row.supporter_extra === null?'없어요':'네, '+row.supporter_extra,
    fields:['supporter_extra'],expected:!noChange};
  cover('supporter_extra','cgchange_more',row.supporter_extra === null?'explicit_negative_not_missing':'verbatim_yes_detail',!noChange);
  answers.extra = {type:'text',kind:'missing',fields:[],expected:true,missing_reason:'source_questionnaire_omits_question_11'};
  check(Object.keys(coverage).length === 29 && SCENARIO24_FIELDS.every(field => coverage[field]) &&
    extras.length === Object.keys(row.extras).length, 'SOURCE_COVERAGE');
  const plan = {version:1,case_id:row.id,title:row.title,synthetic:true,source_row_sha256:hashValue(row),
    source_hashes:structuredClone(sourceHashes),answers,source_coverage:SCENARIO24_FIELDS.map(field => coverage[field]),
    extras_coverage:extras,management_fields_excluded:['schema_version','synthetic','usage','id','title','focus']};
  return freeze({...plan,plan_sha256:hashValue(plan)});
}

export function buildScenario24Plans(rows, options, sourceHashes = {}) {
  check(Array.isArray(rows) && rows.length === 24, 'CASE_COUNT');
  check(isDeepStrictEqual(rows.map(row=>row.id),Array.from({length:24},(_,index)=>index+3)), 'CASE_IDS_OR_ORDER');
  return freeze(rows.map(row=>buildScenario24Plan(row,options,sourceHashes)));
}

function validatePlan(plan) {
  check(plain(plan) && typeof plan.plan_sha256 === 'string', 'PLAN');
  const {plan_sha256,...body} = plan;
  check(hashValue(body) === plan_sha256, 'PLAN_CHANGED');
}

export function scenario24Answer(plan, question, revision) {
  validatePlan(plan);
  check(plain(question) && Object.hasOwn(plan.answers,question.id), 'UNMAPPED_QUESTION');
  check(question.follow_up !== true && !question.follow_up, 'UNPLANNED_FOLLOWUP');
  check(Number.isSafeInteger(revision) && revision >= 0, 'REVISION');
  const spec = plan.answers[question.id];
  check(question.type === spec.type, 'QUESTION_TYPE_CHANGED');
  check(spec.expected, 'UNEXPECTED_CONDITIONAL_QUESTION');
  const input = {revision,question_id:question.id,text:'',selected:[],custom:'',skipped:false,follow_up:false};
  if (spec.kind === 'missing') {
    check(!question.required && !question.noSkip, 'MISSING_REQUIRED_SOURCE');
    input.skipped = true;
  } else if (spec.kind === 'text') {
    check(!question.opts, 'TEXT_QUESTION_HAS_OPTIONS');
    input.text = spec.text;
  } else {
    check(Array.isArray(question.opts) && question.opts.length > 0, 'ACTUAL_OPTIONS');
    const labels = question.opts.map(option => Array.isArray(option)?option[0]:option);
    check(labels.every(text) && new Set(labels).size === labels.length, 'AMBIGUOUS_ACTUAL_OPTIONS');
    input.selected = spec.labels.map(label => {
      const index = labels.indexOf(label);check(index >= 0, 'SELECTED_OPTION_MISSING');return index;
    });
    input.custom = spec.customParts.map(part => part.text).join('\n');
    check(!(question.noOwn && input.custom), 'CUSTOM_NOT_ALLOWED');
    check(!(question.type === 'one' && (input.selected.length > 1 || input.selected.length && input.custom)), 'ONE_SELECTION');
    check(!(input.selected.length > 1 && input.selected.some(index => Array.isArray(question.opts[index]) && question.opts[index][1]?.none)), 'EXCLUSIVE_SELECTION');
    if (spec.kind === 'detail') {
      check(input.selected.length === 1 && Array.isArray(question.opts[input.selected[0]]) &&
        question.opts[input.selected[0]][1]?.input === true, 'DETAIL_CHANNEL_CHANGED');
      input.text = spec.labels[0] + ', ' + spec.detail;
    } else input.text = [...spec.labels,...(input.custom?[input.custom]:[])].join(', ');
    check(input.selected.length > 0 || text(input.custom), 'EMPTY_SELECTION_SOURCE');
  }
  check(input.text.length <= 10000 && input.custom.length <= 10000, 'ANSWER_TOO_LONG');
  return {input,provenance:{case_id:plan.case_id,plan_sha256:plan.plan_sha256,fields:[...spec.fields],
    input_sha256:hashValue(input),missing_source:spec.kind === 'missing',
    ...(spec.missing_reason?{missing_reason:spec.missing_reason}:{})}};
}

export function validateScenario24Coverage(plan, turns, {requireComplete = false} = {}) {
  validatePlan(plan);check(Array.isArray(turns), 'TURN_LIST');
  const submitted = new Set(),attempted = new Set();
  for (const turn of turns) {
    const question = turn.question ?? turn.view_before?.question;
    check(question && turn.input && !attempted.has(question.id), 'DUPLICATE_OR_MISSING_TURN');
    const expected = scenario24Answer(plan,question,turn.input.revision);
    check(isDeepStrictEqual(turn.input,expected.input) && (!turn.provenance || isDeepStrictEqual(turn.provenance,expected.provenance)), 'INPUT_OR_PROVENANCE_CHANGED');
    attempted.add(question.id);
    if (turn.completed === true || turn.status === 200) submitted.add(question.id);
  }
  const coverage = [...plan.source_coverage,...plan.extras_coverage].map(item => ({...item,
    status:submitted.has(item.target)?'submitted':plan.answers[item.target].expected===false?'not_asked_by_source_condition':
      attempted.has(item.target)?'attempted_not_completed':'not_submitted'}));
  const missing = Object.entries(plan.answers).filter(([id,spec]) => spec.expected && !submitted.has(id)).map(([id])=>id);
  if (requireComplete) check(missing.length === 0, 'INCOMPLETE_COVERAGE');
  return {case_id:plan.case_id,complete:missing.length===0,original_field_count:29,source_coverage:coverage,
    missing_questions:missing,extra_question:{source:'missing',status:submitted.has('extra')?'explicitly_skipped':'not_submitted'},
    limitations:['Coverage describes fixed source submission and explicit conditions; it does not certify model quality.']};
}

export async function loadScenario24Inputs({directory}) {
  check(typeof directory === 'string' && directory.length > 0, 'INPUT_DIRECTORY');
  const base = resolve(directory);check(await realpath(base) === base, 'NONCANONICAL_INPUT_DIRECTORY');
  async function read(name) {
    check(typeof name === 'string' && !isAbsolute(name) && !name.split(/[\\/]/).includes('..'), 'INPUT_PATH');
    const path = resolve(base,name);check(relative(base,path) && !relative(base,path).startsWith('..') && await realpath(path) === path, 'NONCANONICAL_INPUT_PATH');
    return readFile(path);
  }
  const names = ['구조화_데이터/답변_예시_24개.jsonl','구조화_데이터/선택지_사전.json','전체_답변_예시_24개.txt'];
  const bytes = await Promise.all(names.map(read));
  const auditBytes = await read('구조화_데이터/재검증결과.json');
  const audit = JSON.parse(auditBytes.toString('utf8'));
  const hashes = Object.fromEntries(names.map((name,index)=>[name,sha(bytes[index])]));
  check(audit.status === 'passed' && audit.case_count === 24 && audit.answers_compared === 696 &&
    names.every(name => audit.input_sha256?.[name] === hashes[name]), 'SOURCE_HASH_MISMATCH');
  const lines = bytes[0].toString('utf8').trimEnd().split('\n');
  check(lines.length === 24 && lines.every(line=>line.trim().length>0), 'CASE_COUNT');
  const rows = lines.map(line=>JSON.parse(line));
  check(isDeepStrictEqual(rows.map(row=>row.id),Array.from({length:24},(_,index)=>index+3)), 'CASE_IDS_OR_ORDER');
  const options = JSON.parse(bytes[1].toString('utf8'));
  const manifestBytes = await read('구조화_데이터/검증결과.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  check(manifest.status === 'passed' && manifest.files?.length === 24, 'FILE_MANIFEST');
  const texts = [];
  for (let index=0;index<24;index++) {
    const file = manifest.files[index];check(file.id === rows[index].id && file.file.startsWith('개별_답변/'), 'FILE_CASE_ID');
    const content = await read(file.file);check(sha(content) === file.sha256, 'INDIVIDUAL_HASH_MISMATCH');texts.push(content.toString('utf8'));
  }
  check(isDeepStrictEqual(bytes[2].toString('utf8').split('\n\n'+'='.repeat(70)+'\n\n'),texts), 'COMBINED_TEXT_MISMATCH');
  return freeze({cases:buildScenario24Plans(rows,options,hashes),source_hashes:hashes,
    validation:{case_count:24,original_answer_count:696,source_audit_sha256:sha(auditBytes),
      source_manifest_sha256:sha(manifestBytes),individual_and_combined_hashes_match:true,
      limitations:['The retained TXT/JSONL audit is hash-bound. This loader does not independently repeat its TXT semantic parser.',
        'The caller must use actual service questions; current database wording and conditional paths are not inferred here.']}});
}
