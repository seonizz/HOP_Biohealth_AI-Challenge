"""Read-only quality diagnostics; never silently reconcile source differences."""
from collections import Counter
import json
from pathlib import Path
import sqlite3
import unicodedata
from .numeric import dump


def compact(text):return ''.join(unicodedata.normalize('NFC',text).split())

def audit_pairs(output):
    output=Path(output);db=sqlite3.connect(output/'corpus.sqlite')
    counts=Counter();records=[]
    query='''SELECT p.json_source_id,p.txt_source_id,p.comparison,c.raw_json,t.text
      FROM source_pairs p JOIN sources s ON s.source_id=p.json_source_id
      JOIN conversations c ON c.conversation_id=s.conversation_id
      JOIN source_texts t ON t.source_id=p.txt_source_id ORDER BY p.json_source_id,p.txt_source_id'''
    for jsid,tsid,original,raw,txt in db.execute(query):
        payload=json.loads(raw);paragraphs=payload['paragraph'];lines=[];usable=True
        for paragraph in paragraphs:
            if not isinstance(paragraph,dict) or not isinstance(paragraph.get('paragraph_text'),str) or not isinstance(paragraph.get('paragraph_speaker'),str):
                usable=False;break
            lines.append(paragraph['paragraph_speaker']+' : '+paragraph['paragraph_text'])
        tagged='\n'.join(lines)
        if original!='content_difference':status=original
        elif not usable:status='nonstring_source_text_cannot_compare_all_turns'
        elif tagged==txt:status='matches_when_source_speaker_prefixes_restored'
        elif compact(tagged)==compact(txt):status='matches_speaker_prefixes_plus_unicode_whitespace'
        else:status='content_difference_remains'
        counts[status]+=1;records.append({'json_source_id':jsid,'txt_source_id':tsid,'status':status})
    db.close();result={'comparison_counts':dict(counts),'pairs':records,
      'method':'Compare stored TXT to original paragraph speaker + colon + text; optionally ignore Unicode composition and whitespace only',
      'source_mutated':False,'differences_repaired':False}
    dump(output/'pairing_audit.json',result);return result
