"""Train-only numeric representations; NumPy only, no remote models or APIs."""
from __future__ import annotations
import array
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import unicodedata
import zlib
import numpy as np
from .text import tokenize, WORD_METHOD, NORMALIZATION_METHOD

DENSE_COLUMNS = ['characters','nonspace_characters','tokens','unique_tokens','type_token_ratio',
                 'digit_ratio','punctuation_ratio','question_count','exclamation_count',
                 'hangul_ratio','mean_token_length','max_token_length','adjacent_repetition_ratio']

def dump(path, value):
    path=Path(path);temp=path.with_suffix(path.suffix+'.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)

def tokens(text):
    return tokenize(text)

def terms(text):
    t = tokens(text)
    return ['u:'+x for x in t] + ['b:'+a+'\x1f'+b for a,b in zip(t,t[1:])]

def stats(text):
    t=tokens(text); n=len(text); k=len(t)
    return [n,sum(not x.isspace() for x in text),k,len(set(t)),len(set(t))/max(k,1),
            sum(x.isdigit() for x in text)/max(n,1),
            sum(unicodedata.category(x).startswith('P') for x in text)/max(n,1),
            text.count('?'),text.count('!'),sum('가'<=x<='힣' for x in text)/max(n,1),
            sum(map(len,t))/max(k,1),max(map(len,t),default=0),
            sum(a==b for a,b in zip(t,t[1:]))/max(k-1,1)]

class CSR:
    """Grow using packed arrays, export the documented SciPy CSR NPZ format."""
    def __init__(self, columns):
        self.columns=columns; self.indices=array.array('i'); self.data=array.array('f'); self.indptr=array.array('q',[0])
    def append(self, values):
        for k,v in sorted(values.items()):
            if v:
                self.indices.append(k); self.data.append(v)
        self.indptr.append(len(self.data))
    def save(self, path, mode='count', idf=None):
        data=np.frombuffer(self.data,dtype=np.float32).copy()
        indices=np.frombuffer(self.indices,dtype=np.int32)
        indptr=np.frombuffer(self.indptr,dtype=np.int64)
        if mode=='binary': data[:]=1
        if mode=='tfidf':
            data=(1+np.log(data))*idf[indices]
            for start,end in zip(indptr[:-1],indptr[1:]):
                norm=np.linalg.norm(data[start:end])
                if norm:data[start:end]/=norm
        np.savez_compressed(path, format=np.array(b'csr'), shape=np.array([len(indptr)-1,self.columns]),
                            data=data,indices=indices,indptr=indptr)
        return {'shape':[len(indptr)-1,self.columns],'nnz':len(data),'dtype':'float32',
                'finite':bool(np.isfinite(data).all()),'density':len(data)/max((len(indptr)-1)*self.columns,1)}

def hash_counts(items, dimensions):
    result=Counter()
    for x in items:result[zlib.crc32(x.encode('utf-8'))%dimensions]+=1
    return result

def char_ngrams(text):
    text=unicodedata.normalize('NFC',text).casefold()
    for n in (2,3):
        for i in range(len(text)-n+1):yield text[i:i+n]

def fingerprint(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def representations(output:Path, config:dict):
    output=Path(output); root=output/'numeric'; root.mkdir(exist_ok=True)
    cfg_hash=hashlib.sha256((json.dumps(config,sort_keys=True)+fingerprint(__file__)+fingerprint(Path(__file__).with_name('text.py'))).encode()).hexdigest()
    dbhash=fingerprint(output/'corpus.sqlite')
    finished=root/'manifest.json'
    if finished.exists():
        previous=json.loads(finished.read_text())
        if previous.get('input_sha256')==dbhash and previous.get('config_sha256')==cfg_hash:
            if all((root/r['path']).exists() and r.get('sha256')==fingerprint(root/r['path']) for r in previous['artifacts']):return previous
    db=sqlite3.connect(output/'corpus.sqlite'); db.row_factory=sqlite3.Row
    artifacts=[]
    def record(path, unit, method, detail=None, **kw):
        r={'path':str(Path(path).relative_to(root)),'unit':unit,'method':method,
           'fit_partition':'train' if method not in ('text_statistics','feature_hashing','structure') else 'none',
           'target_free':True,'version':'1','missing_policy':'explicit observation masks or finite zero for empty text',
           **(detail or {}),**kw}
        artifacts.append(r)
    # Sentence-level fit: DF is one vote per training sentence; validation is transform-only.
    df=Counter(); tf=Counter(); word_tf=Counter(); ntrain=0
    for (text,) in db.execute("SELECT text FROM sentences WHERE split='train'"):
        ts=terms(text); tf.update(ts);df.update(set(ts));word_tf.update(tokens(text));ntrain+=1
    if not ntrain:raise ValueError('No eligible training sentences; refusing to fit on validation/quarantine')
    print(f'numeric: fit vocabulary on {ntrain:,} train sentences', flush=True)
    vocab_terms=sorted(df,key=lambda t:(-df[t],t))[:config['word_vocabulary_limit']]
    vocabulary={x:i for i,x in enumerate(vocab_terms)}
    idf=np.array([math.log((1+ntrain)/(1+df[t]))+1 for t in vocab_terms],dtype=np.float32)
    dump(root/'vocabulary.json',{'fit_partition':'train','fit_unit':'sentence','train_rows':ntrain,
         'terms':vocab_terms,'document_frequency':[df[t] for t in vocab_terms],
         'term_frequency':[tf[t] for t in vocab_terms],'normalization':NORMALIZATION_METHOD,
         'tokenization':WORD_METHOD + '; NOT Korean morphemes',
         'idf':'log((1+n_train)/(1+df))+1','tfidf_tf':'1+log(count)','tfidf_norm':'L2',
         'identifier_not_distance':True})
    np.save(root/'idf.npy',idf)
    record(root/'vocabulary.json','shared','vocabulary',{'shape':[len(vocab_terms)]})
    record(root/'idf.npy','shared','idf',{'shape':list(idf.shape)})
    # Distributional representation from actual train-only local co-occurrences.
    words=sorted(word_tf,key=lambda t:(-word_tf[t],t))[:config['cooccurrence_vocabulary_limit']]
    wi={w:i for i,w in enumerate(words)}; v=len(words)
    co=np.zeros((v,v),dtype=np.float32); window=config['cooccurrence_window']
    for (text,) in db.execute("SELECT text FROM sentences WHERE split='train'"):
        ts=tokens(text)
        for pos,w in enumerate(ts):
            a=wi.get(w)
            if a is None:continue
            for neighbor in ts[pos+1:pos+window+1]:
                b=wi.get(neighbor)
                if b is not None:co[a,b]+=1;co[b,a]+=1
    total=float(co.sum()); marg=co.sum(axis=1,dtype=np.float64)
    denominator=marg[:,None]*marg[None,:]
    ppmi=np.zeros_like(co)
    mask=(co>0)&(denominator>0)
    if total:ppmi[mask]=np.maximum(0,np.log(co[mask]*total/denominator[mask])).astype(np.float32)
    rank=min(config['svd_dimensions'],max(1,v-1))
    rng=np.random.default_rng(config['random_seed'])
    omega=rng.standard_normal((v,min(v,rank+8)),dtype=np.float32)
    q,_=np.linalg.qr(ppmi@omega)
    # One power iteration; decomposition never consumes held-out text.
    q,_=np.linalg.qr(ppmi@(ppmi.T@q))
    u,s,vt=np.linalg.svd(q.T@ppmi,full_matrices=False)
    embedding=((q@u[:,:rank])*np.sqrt(s[:rank])).astype(np.float32)
    np.save(root/'word_cooccurrence.npy',co);np.save(root/'word_ppmi.npy',ppmi)
    np.save(root/'word_distributional.npy',embedding);np.save(root/'svd_singular_values.npy',s[:rank])
    dump(root/'distributional_vocabulary.json',{'words':words,'window':window,'rank':rank,
         'method':'symmetric sentence-bounded PPMI + randomized SVD U sqrt(S)',
         'fit_partition':'train','seed':config['random_seed'],'oov':'zero vector + coverage mask',
         'not_neural_embedding':True})
    for name,matrix,method in [('word_cooccurrence',co,'cooccurrence'),('word_ppmi',ppmi,'ppmi'),
                               ('word_distributional',embedding,'distributional_svd')]:
        record(root/(name+'.npy'),'vocabulary',method,{'shape':list(matrix.shape),'dtype':str(matrix.dtype),
               'finite':bool(np.isfinite(matrix).all())},row_mapping='distributional_vocabulary.json')
    record(root/'distributional_vocabulary.json','vocabulary','distributional_vocabulary')
    record(root/'svd_singular_values.npy','vocabulary','svd_spectrum',{'shape':[rank]})
    graph=np.column_stack(((co>0).sum(axis=1),co.sum(axis=1),ppmi.sum(axis=1))).astype(np.float32)
    np.save(root/'word_graph_statistics.npy',graph)
    record(root/'word_graph_statistics.npy','vocabulary','graph_statistics',{'shape':list(graph.shape)},
           columns=['observed_degree','weighted_degree','ppmi_weight_sum'],row_mapping='distributional_vocabulary.json')
    del co,ppmi,denominator,mask,q,u,vt,omega
    # Text only: no summary, original labels, generated labels or reviewer decisions.
    for unit,table,idcol in [('sentence','sentences','sentence_id'),('conversation','conversations','conversation_id')]:
        print('numeric: transforming '+unit, flush=True)
        count=db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
        dense=np.lib.format.open_memmap(root/f'{unit}_statistics.npy',mode='w+',dtype=np.float32,shape=(count,len(DENSE_COLUMNS)))
        pooled=np.lib.format.open_memmap(root/f'{unit}_distributional.npy',mode='w+',dtype=np.float32,shape=(count,rank+1))
        counts=CSR(len(vocab_terms)); whash=CSR(config['word_hash_dimensions']); chash=CSR(config['char_hash_dimensions'])
        empty=0;oov=0;token_count=0;dist_oov=0
        with (root/f'{unit}_rows.jsonl').open('w',encoding='utf-8') as rows:
            for row,(rowid,text,split) in enumerate(db.execute(f'SELECT {idcol},text,split FROM {table} ORDER BY {idcol}')):
                rows.write(json.dumps({'row':row,'id':rowid,'split':split},ensure_ascii=False)+'\n')
                ts=tokens(text);nt=len(ts);dense[row]=stats(text)
                values=Counter(vocabulary[t] for t in terms(text) if t in vocabulary)
                counts.append(values);whash.append(hash_counts(ts,config['word_hash_dimensions']))
                chash.append(hash_counts(char_ngrams(text),config['char_hash_dimensions']))
                ids=[wi[w] for w in ts if w in wi];pooled[row,:rank]=embedding[ids].mean(axis=0) if ids else 0
                pooled[row,rank]=len(ids)/max(nt,1)
                empty+=not values;oov+=sum('u:'+w not in vocabulary for w in ts);token_count+=nt;dist_oov+=nt-len(ids)
        dense.flush();pooled.flush()
        record(root/f'{unit}_statistics.npy',unit,'text_statistics',{'shape':list(dense.shape),'dtype':'float32'},
               columns=DENSE_COLUMNS,row_mapping=f'{unit}_rows.jsonl')
        record(root/f'{unit}_distributional.npy',unit,'distributional_pooling',{'shape':list(pooled.shape),'dtype':'float32'},
               pooling='mean known-token PPMI/SVD vectors',coverage_column=rank,oov_rate=dist_oov/max(token_count,1),
               row_mapping=f'{unit}_rows.jsonl',context='current unit; full conversation offline when unit=conversation')
        for name,mode in [('count','count'),('binary','binary'),('tfidf','tfidf')]:
            path=root/f'{unit}_{name}.npz';detail=counts.save(path,mode,idf)
            record(path,unit,name,detail,row_mapping=f'{unit}_rows.jsonl',vocabulary='vocabulary.json',
                   empty_rows=empty,token_oov_rate=oov/max(token_count,1))
        for name,matrix in [('word_hash',whash),('char_hash',chash)]:
            path=root/f'{unit}_{name}.npz';detail=matrix.save(path)
            record(path,unit,'feature_hashing',detail,row_mapping=f'{unit}_rows.jsonl',
                   algorithm='unsigned CRC32 modulo dimensions; collisions possible',
                   analyzer='word tokens' if name=='word_hash' else 'character 2,3-grams')
        record(root/f'{unit}_rows.jsonl',unit,'row_mapping',{'rows':count})
        del counts,whash,chash,dense,pooled
    word_occurrence_features(db,root,record,wi,embedding)
    print('numeric: structure and original label masks', flush=True)
    structure_features(db,root,record)
    source_numeric_metadata(db,root,record)
    original_label_features(db,root,record)
    quality_summary(root,artifacts,record)
    for artifact in artifacts:
        artifact['sha256']=fingerprint(root/artifact['path'])
    manifest={'version':'1','created_at':datetime.now(timezone.utc).isoformat(),'input_sha256':dbhash,
       'config_sha256':cfg_hash,'config':config,'fit_partition':'train','fit_train_sentences':ntrain,
       'artifacts':artifacts,'methods':[
        {'family':name,'status':'implemented'} for name in ['text_statistics','word_ngram_count_binary_tfidf',
        'feature_hashing','original_categorical_labels_and_masks','cooccurrence_ppmi_graph',
        'distributional_svd_pooling','dialogue_structure','adjacent_distributional_similarity',
        'source_numeric_metadata','quality_distribution_correlation']]
        +[{'family':'korean_morphology_syntax','status':'blocked','reason':'No installed Korean morphological analyzer; regex tokens are not morphemes'},
          {'family':'word2vec_fasttext','status':'blocked','reason':'No installed implementation or applicable pretrained model; no new dependency authorization'},
          {'family':'neural_contextual_embeddings','status':'blocked','reason':'No installed text encoder runtime or applicable local weights; PPMI/SVD is a separate distributional representation'},
          {'family':'verified_label_transitions','status':'blocked','reason':'Code definitions unresolved; raw code transitions must not be interpreted as clinical change'}]}
    dump(finished,manifest);db.close();return manifest

def word_occurrence_features(db,root,record,wi,embedding):
    # A normalized lexical dictionary covers ALL observed forms; train count is separate.
    vocab=list(db.execute('SELECT normalized,count(*),sum(split=\'train\') FROM words GROUP BY normalized ORDER BY normalized'))
    word_index={r[0]:i for i,r in enumerate(vocab)}
    values=np.array([stats(r[0])+[r[2]] for r in vocab],dtype=np.float32)
    np.save(root/'word_lexical_statistics.npy',values)
    exploration=root/'exploration';exploration.mkdir(exist_ok=True)
    with (root/'word_vocabulary.jsonl').open('w',encoding='utf-8') as f,(exploration/'word_total_counts.jsonl').open('w',encoding='utf-8') as exploratory:
        for i,(word,total,train) in enumerate(vocab):
            f.write(json.dumps({'row':i,'word':word,'train_count':train,
                'train_observed':train>0,'distributional_row':wi.get(word),'identifier_not_distance':True},ensure_ascii=False)+'\n')
            exploratory.write(json.dumps({'row':i,'total_count':total})+'\n')
    record(root/'word_lexical_statistics.npy','vocabulary','text_statistics',{'shape':list(values.shape)},
           columns=DENSE_COLUMNS+['train_count'],row_mapping='word_vocabulary.jsonl')
    record(exploration/'word_total_counts.jsonl','vocabulary','exploratory_frequency',{'rows':len(vocab)},
           fit_partition='all; exploration only, never a training input',target_free=False,training_input=False)
    n=db.execute('SELECT count(*) FROM words').fetchone()[0]
    # IDs/offsets are int64 metadata, never a metric distance or a clinical score.
    mapping=np.lib.format.open_memmap(root/'word_occurrence_mapping.npy',mode='w+',dtype=np.int64,shape=(n,6))
    with (root/'word_occurrence_rows.jsonl').open('w',encoding='utf-8') as f:
        for i,r in enumerate(db.execute('SELECT word_occurrence_id,normalized,ordinal,start_char,end_char,split FROM words ORDER BY word_occurrence_id')):
            occurrence,word,ordinal,start,end,split=r
            mapping[i]=[word_index[word],wi.get(word,-1),ordinal,start,end,word in wi]
            f.write(json.dumps({'row':i,'id':occurrence,'split':split})+'\n')
    mapping.flush()
    record(root/'word_occurrence_mapping.npy','word_occurrence','lexical_vector_reference',{'shape':list(mapping.shape),'dtype':'int64'},
           columns=['lexical_row','distributional_row_minus_one_if_oov','ordinal','utterance_start','utterance_end','distributional_observed'],
           row_mapping='word_occurrence_rows.jsonl',note='Gather lexical/distributional vectors by row; do not use identifiers as distances')
    record(root/'word_vocabulary.jsonl','vocabulary','row_mapping',{'rows':len(vocab)},fit_partition='none; all observed lexical inventory, train counts separately marked')
    record(root/'word_occurrence_rows.jsonl','word_occurrence','row_mapping',{'rows':n})

def structure_features(db,root,record):
    ids=[r[0] for r in db.execute('SELECT sentence_id FROM sentences ORDER BY sentence_id')];index={sid:i for i,sid in enumerate(ids)}
    pooled=np.load(root/'sentence_distributional.npy',mmap_mode='r')
    matrix=np.zeros((len(ids),7),dtype=np.float32)
    conversation_rows={r[0]:i for i,r in enumerate(db.execute('SELECT conversation_id FROM conversations ORDER BY conversation_id'))}
    conv=np.zeros((len(conversation_rows),6),dtype=np.float32)
    current=None; previous=None;prev_speaker=None;prev_utterance=None;utt_count=0;turns=0;sent_count=0;lengths=[]
    def flush():
        if current is not None:
            conv[conversation_rows[current]]=[utt_count,sent_count,turns,len(lengths),np.mean(lengths) if lengths else 0,max(lengths,default=0)]
    query='''SELECT s.sentence_id,s.conversation_id,s.utterance_id,s.ordinal,s.speaker,length(s.text),u.ordinal
             FROM sentences s JOIN utterances u USING(utterance_id) ORDER BY s.conversation_id,u.ordinal,s.ordinal'''
    for sid,cid,uid,ordinal,speaker,length,uordinal in db.execute(query):
        if current!=cid:
            flush();current=cid;previous=None;prev_speaker=None;prev_utterance=None;utt_count=0;turns=0;sent_count=0;lengths=[]
        i=index[sid];new_utterance=uid!=prev_utterance;switch=previous is not None and speaker!=prev_speaker
        similarity=0.;valid=0.
        if previous is not None:
            a=pooled[i,:-1];b=pooled[previous,:-1];norm=float(np.linalg.norm(a)*np.linalg.norm(b))
            if norm:similarity=float(np.dot(a,b)/norm);valid=1.
        matrix[i]=[uordinal,ordinal,sent_count,int(switch),int(new_utterance),similarity,valid]
        utt_count+=new_utterance;turns+=switch;sent_count+=1;lengths.append(length)
        previous=i;prev_speaker=speaker;prev_utterance=uid
    flush();np.save(root/'sentence_structure.npy',matrix);np.save(root/'conversation_structure.npy',conv)
    record(root/'sentence_structure.npy','sentence','structure',{'shape':list(matrix.shape)},
           columns=['utterance_ordinal','sentence_ordinal','conversation_sentence_ordinal','speaker_change','new_utterance','previous_cosine','cosine_observed'],
           row_mapping='sentence_rows.jsonl',note='Order/context only; cosine is distributional similarity, not emotion or clinical change')
    record(root/'conversation_structure.npy','conversation','structure',{'shape':list(conv.shape)},
           columns=['utterances_with_sentences','sentences','speaker_switches','sentence_length_count','mean_sentence_length','max_sentence_length'],row_mapping='conversation_rows.jsonl',context='offline full conversation')

def source_numeric_metadata(db,root,record):
    for unit,table,idcol,columns in [
        ('utterance','utterances','utterance_id',['start_point','end_point','character_count','cps']),
        ('conversation','conversations','conversation_id',['age','silence','total_time'])]:
        n=db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
        values=np.zeros((n,len(columns)),dtype=np.float32);observed=np.zeros_like(values,dtype=np.uint8)
        completeness=np.zeros((n,3),dtype=np.int64) if unit=='conversation' else None
        with (root/f'{unit}_metadata_rows.jsonl').open('w') as f:
            for i,(uid,raw) in enumerate(db.execute(f'SELECT {idcol},raw_json FROM {table} ORDER BY {idcol}')):
                obj=json.loads(raw)
                if not isinstance(obj,dict):obj={}
                for j,key in enumerate(columns):
                    value=obj.get(key)
                    if type(value) in (float,int) and math.isfinite(value):values[i,j]=value;observed[i,j]=1
                if completeness is not None:
                    paragraphs=obj.get('paragraph',[]);present=sum(isinstance(p.get('paragraph_text'),str) for p in paragraphs if isinstance(p,dict))
                    completeness[i]=[len(paragraphs),present,len(paragraphs)-present]
                f.write(json.dumps({'row':i,'id':uid})+'\n')
        for name,matrix in [('source_numeric',values),('source_numeric_observed',observed)]:
            path=root/f'{unit}_{name}.npy';np.save(path,matrix)
            record(path,unit,'source_numeric_metadata',{'shape':list(matrix.shape),'dtype':str(matrix.dtype)},
                   fit_partition='none; raw source quantities',columns=columns,row_mapping=f'{unit}_metadata_rows.jsonl',
                   note='Source units retained. Not newly measured; no sentence timing interpolation. Zero fill only with observation mask.')
        record(root/f'{unit}_metadata_rows.jsonl',unit,'row_mapping',{'rows':n},fit_partition='none')
        if completeness is not None:
            np.save(root/'conversation_text_completeness.npy',completeness)
            record(root/'conversation_text_completeness.npy',unit,'source_quality_mask',{'shape':list(completeness.shape),'dtype':'int64'},
                   fit_partition='none',columns=['source_utterances','text_observed_utterances','nonstring_or_missing_text_utterances'],
                   row_mapping='conversation_rows.jsonl',note='Conversation statistics are partial when the final column is nonzero.')

def original_label_features(db,root,record):
    for unit,table,idcol,scope in [('utterance','utterances','utterance_id','original utterance only'),
                                 ('conversation','conversations','conversation_id','original conversation only')]:
        observed=Counter();keys=set();categories=set()
        source_keys={r[0] for r in db.execute('SELECT DISTINCT label_key FROM original_labels WHERE scope=?',(unit,))}
        for (raw,) in db.execute(f'SELECT raw_json FROM {table}'):
            obj=json.loads(raw)
            if not isinstance(obj,dict):obj={}
            for k,v in obj.items():
                if k in source_keys:
                    key=json.dumps([k,type(v).__name__,v],ensure_ascii=False,sort_keys=True)
                    keys.add(k);categories.add(key);observed[key]+=1
        # Schema categories include all ORIGINAL values, are targets not fitted text inputs.
        keys=sorted(keys);ki={k:i for i,k in enumerate(keys)};categories=sorted(categories);ci={k:i for i,k in enumerate(categories)}
        onehot=CSR(len(categories));mask=CSR(len(keys));nonnull=CSR(len(keys))
        with (root/f'{unit}_label_rows.jsonl').open('w') as f:
            for row,(uid,raw) in enumerate(db.execute(f'SELECT {idcol},raw_json FROM {table} ORDER BY {idcol}')):
                obj=json.loads(raw);active={};present={};notnull={}
                if not isinstance(obj,dict):obj={}
                for k in keys:
                    if k in obj:
                        v=obj[k];active[ci[json.dumps([k,type(v).__name__,v],ensure_ascii=False,sort_keys=True)]]=1
                        present[ki[k]]=1
                        if v is not None:notnull[ki[k]]=1
                onehot.append(active);mask.append(present);nonnull.append(notnull)
                f.write(json.dumps({'row':row,'id':uid})+'\n')
        dictionary={'scope':scope,'keys':keys,'categories':[json.loads(x) for x in categories],
            'category_counts':[observed[x] for x in categories],
            'definition_status':'unresolved numeric semantics; typed categorical preservation only',
            'applicability':'unknown; presence and nonnull masks are NOT applicability masks',
            'sentence_word_policy':'Reference utterance_id; never broadcast as sentence/word ground truth',
            'missing_vs_zero':'Missing has presence=0; null presence=1 nonnull=0; zero has its own typed category'}
        dump(root/f'{unit}_label_dictionary.json',dictionary)
        for name,csr in [('original_labels',onehot),('label_observed',mask),('label_nonnull',nonnull)]:
            path=root/f'{unit}_{name}.npz'
            record(path,unit,'original_categorical_labels_and_masks',csr.save(path),target_free=False,
                   fit_partition='none; original schema/category preservation, not model features',scope=scope,
                   row_mapping=f'{unit}_label_rows.jsonl',dictionary=f'{unit}_label_dictionary.json')
        record(root/f'{unit}_label_dictionary.json',unit,'label_dictionary',target_free=False,fit_partition='none')
        record(root/f'{unit}_label_rows.jsonl',unit,'row_mapping',target_free=False,fit_partition='none')

def quality_summary(root,artifacts,record):
    """Whole-corpus descriptive diagnostics, isolated from learned transformers."""
    reports=[]
    for item in artifacts:
        if item['unit'] not in ('sentence','conversation') or item['method'] not in ('text_statistics','structure'):
            continue
        matrix=np.load(root/item['path'],mmap_mode='r');n,d=matrix.shape
        sums=np.zeros(d);squares=np.zeros((d,d));minimum=np.full(d,np.inf);maximum=np.full(d,-np.inf)
        for start in range(0,n,100000):
            block=np.asarray(matrix[start:start+100000],dtype=np.float64)
            sums+=block.sum(axis=0);squares+=block.T@block
            minimum=np.minimum(minimum,block.min(axis=0));maximum=np.maximum(maximum,block.max(axis=0))
        mean=sums/max(n,1);cov=squares/max(n,1)-np.outer(mean,mean);sd=np.sqrt(np.maximum(0,np.diag(cov)))
        denom=sd[:,None]*sd[None,:];correlation=np.divide(cov,denom,out=np.zeros_like(cov),where=denom>0)
        reports.append({'artifact':item['path'],'rows':n,'columns':item['columns'],'mean':mean.tolist(),
          'std':sd.tolist(),'min':minimum.tolist() if n else [None]*d,'max':maximum.tolist() if n else [None]*d,
          'correlation':correlation.clip(-1,1).tolist(),'correlation_observed':(denom>0).tolist()})
    sparse=[{k:item[k] for k in ['path','shape','nnz','density','empty_rows','token_oov_rate'] if k in item}
            for item in artifacts if item['path'].endswith('.npz')]
    path=root/'exploration/quality_summary.json'
    dump(path,{'scope':'all corpus, exploration/quality only; not a fitted training transformer','dense':reports,'sparse':sparse,
         'label_distributions':'See original label dictionaries: typed category_counts preserve code semantics as unknown'})
    record(path,'all','quality_distribution_correlation',fit_partition='all; exploration only',target_free=False,training_input=False)
