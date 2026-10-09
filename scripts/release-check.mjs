import {readFile} from 'node:fs/promises';
const catalog=JSON.parse(await readFile(new URL('../backend/docs/MALSSI_QUESTIONNAIRE_V1.json',import.meta.url),'utf8'));
const checks={published:catalog.publication_status==='published',rights_approved:catalog.rights_status==='approved',content_review_approved:catalog.clinical_review_status==='approved',review_evidence:Array.isArray(catalog.review_refs)&&catalog.review_refs.length>0};
for(const [name,passed] of Object.entries(checks))console.log(`${passed?'PASS':'PENDING'} ${name}`);
if(Object.values(checks).some(x=>!x)){console.error('Public release is not approved. Internal deployment remains available with explicit draft mode.');process.exitCode=1;}
