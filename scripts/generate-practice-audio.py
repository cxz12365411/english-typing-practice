#!/usr/bin/env python3
"""Resumable, local-only Breeze reference speech + offline content QA.

Run with the local MLX Whisper Python environment. No production mutation.
"""
import argparse
import concurrent.futures
import difflib
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
import wave

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'out/practice-audio-20261110'
MODEL = os.environ.get('BREEZE_ASR_MODEL',str(ROOT.parent/'语音转文字/.work/whisper-large-v3-turbo-q4'))
ASR_LOCK = threading.Lock()
WRITE_LOCK = threading.Lock()
CACHE_LOCK = threading.Lock()
CACHE_IDS = {}
PROCESS_VERSION = 1
QA_VERSION = 3
MODEL_SHA = None
# Only identical pronunciations; retained as an explicit QA audit, never text keys.
HOMOPHONE_GROUPS = [
    ('seem','seam'),('see','sea'),('hear','here'),('know','no'),('new','knew'),
    ('eye','i'),('one','won'),('two','too','to'),('four','for'),('eight','ate'),
    ('be','bee'),('by','buy','bye'),('right','write','rite'),('their','there',"they're"),
    ('your',"you're"),('its',"it's"),('weather','whether'),('whole','hole'),
    ('week','weak'),('meet','meat'),('peace','piece'),('plain','plane'),
    ('sale','sail'),('bear','bare'),('pair','pear','pare'),('hair','hare'),
    ('night','knight'),('wait','weight'),('waist','waste'),('road','rode'),
    ('role','roll'),('steel','steal'),('tail','tale'),('threw','through'),
    ('blue','blew'),('break','brake'),('mail','male'),('flour','flower'),
    ('stair','stare'),('stationary','stationery'),('board','bored'),
    ('serial','cereal'),('morning','mourning'),('knows','nose'),('so','sew'),
    ('son','sun'),('allowed','aloud')
]
HOMOPHONES = {word:g[0] for g in HOMOPHONE_GROUPS for word in g}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def qa_signature():
    global MODEL_SHA
    if MODEL_SHA is None:
        h=hashlib.sha256()
        with (Path(MODEL)/'weights.npz').open('rb') as source:
            for block in iter(lambda:source.read(8*1024*1024),b''):h.update(block)
        MODEL_SHA=h.hexdigest()
    rules=OUT/'qa-equivalences.json'
    return sha(json.dumps({'version':QA_VERSION,'asrWeightsSha256':MODEL_SHA,'equivalencesSha256':sha(rules.read_bytes()) if rules.exists() else None},sort_keys=True).encode())


def generation_fingerprint(profile,item):
    return sha(json.dumps({'processVersion':PROCESS_VERSION,'reference':profile['reference'],'originalText':item['originalText'],'spokenText':item['spokenText'],'cfg':1},sort_keys=True).encode())


def required_pronunciation(item):
    review=OUT/'homograph-review.json';guidance=OUT/'pronunciation-guidance.json'
    if item.get('kind')=='word' and review.exists() and guidance.exists():
        word=item['spokenText'].lower()
        if word in json.loads(review.read_text()).get('guided',{}):return json.loads(guidance.read_text()).get(word,'')
    return ''


def atomic_json(path, data):
    with WRITE_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + '.part')
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
        tmp.replace(path)


def words(text):
    s = text.lower().replace('’', "'").replace('-', ' ').replace('%',' percent ')
    s = s.replace('personalised', 'personalized')
    return re.findall(r"[a-z0-9]+(?:'[a-z]+)?", s)


def spoken_equivalents(tokens):
    mapping=dict(HOMOPHONES)
    extra=OUT/'qa-equivalences.json'
    phrases=[]
    if extra.exists():
        config=json.loads(extra.read_text())
        for group in config['groups']:
            canonical=HOMOPHONES.get(group[0],group[0])
            for t in group:mapping[t]=canonical
        for group in config.get('phraseGroups',[]):
            for phrase in group:phrases.append((phrase,group[0]))
    result=[];index=0
    phrases.sort(key=lambda p:len(p[0]),reverse=True)
    while index<len(tokens):
        found=False
        for phrase,canonical in phrases:
            if tokens[index:index+len(phrase)]==phrase:
                result.extend(mapping.get(t,t) for t in canonical);index+=len(phrase);found=True;break
        if not found:result.append(mapping.get(tokens[index],tokens[index]));index+=1
    return result


def export_content():
    source = """
import {readFileSync} from 'node:fs';
import {parseWordMarkdown,parseSentenceMarkdown} from './server/dist/content-parser.js';
import {parseCet4WritingContent} from './server/dist/cet4-writing.js';
import {parseCet6WritingContent} from './server/dist/cet6-writing.js';
const r=p=>readFileSync(p,'utf8');
const sets=[parseWordMarkdown(r('basic-english-850.md')),parseSentenceMarkdown(r('daily-english-high-frequency-sentences.md')),parseCet4WritingContent(JSON.parse(r('cet4-writing.json'))),parseCet6WritingContent(JSON.parse(r('cet6-writing.json')))];
console.log(JSON.stringify(sets.flatMap(s=>s.items)));
"""
    result = subprocess.run(['node', '--input-type=module', '-e', source], cwd=ROOT, capture_output=True, text=True, check=True)
    rows = json.loads(result.stdout)
    unique = {}
    for r in rows:
        original = r['english']
        key = sha(original.encode())
        if key not in unique:
            unique[key] = {'textKey': key, 'originalText': original, 'spokenText': original.replace('____', 'blank'), 'itemKeys': [], 'kind': r['kind']}
        unique[key]['itemKeys'].append(r['key'])
    items = list(unique.values())
    assert len(rows) == 1328 and len(items) == 1328, 'Public baseline changed: inspect before generating'
    atomic_json(OUT / 'content-snapshot.json', {'version': 1, 'source': 'public repository seed content; excludes private imports', 'items': items})
    return items


def transcribe(path, expected):
    import mlx_whisper
    with ASR_LOCK:
        start = time.time()
        result = mlx_whisper.transcribe(str(path), path_or_hf_repo=MODEL, language='en', task='transcribe', temperature=0, verbose=False, word_timestamps=True, condition_on_previous_text=False)
    actual = result['text'].strip()
    a, b = words(expected), words(actual)
    diff = [{'type': tag, 'expected': ' '.join(a[i:j]), 'heard': ' '.join(b[k:l])} for tag,i,j,k,l in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if tag != 'equal']
    equivalent=bool(diff) and spoken_equivalents(a)==spoken_equivalents(b)
    return {'transcript': actual, 'differences': diff, 'status': 'passed' if not diff or equivalent else 'review', 'homophoneEquivalent': equivalent, 'segments': result.get('segments', []), 'seconds': round(time.time()-start, 3), 'method': 'local offline MLX Whisper large-v3-turbo-q4, no text prompt; explicit homophone QA equivalence'}


def signal(path):
    import numpy as np
    with wave.open(str(path)) as w:
        sr, channels, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        values = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2')
    assert sr == 24000 and channels == 1 and width == 2
    f = values.astype(float) / 32768
    peak = float(np.max(abs(f)))
    rms = float(np.sqrt(np.mean(f*f)))
    assert len(values) >= 4800 and peak > 1e-5, 'Empty/too short/silent audio'
    peak_db=20*math.log10(max(peak,1e-12))
    head=20*math.log10(max(float(np.sqrt(np.mean(f[:240]**2))),1e-12))
    tail=20*math.log10(max(float(np.sqrt(np.mean(f[-240:]**2))),1e-12))
    first_db=20*math.log10(max(abs(float(f[0])),1e-12));last_db=20*math.log10(max(abs(float(f[-1])),1e-12))
    start_risk=first_db>min(-50,peak_db-30) and head>min(-45,peak_db-25)
    end_risk=last_db>min(-50,peak_db-30) and tail>min(-45,peak_db-25)
    return {'sampleRate': sr, 'channels': channels, 'sampleBits': width*8, 'duration': len(values)/sr, 'peakDbfs': peak_db, 'rmsDbfs': 20*math.log10(max(rms, 1e-12)), 'clippedSamples': int(np.sum(abs(values.astype(int)) >= 32767)), 'firstSample':int(values[0]),'lastSample':int(values[-1]),'firstSampleDbfs':first_db,'lastSampleDbfs':last_db,'first10msRmsDbfs':head,'last10msRmsDbfs':tail,'startBoundaryRisk':bool(start_risk),'endBoundaryRisk':bool(end_risk)}


def clean_signal(sig):
    return sig['clippedSamples']==0 and not sig['startBoundaryRisk'] and not sig['endBoundaryRisk']


def read_pcm(path):
    with wave.open(str(path)) as w:
        if (w.getframerate(),w.getnchannels(),w.getsampwidth())!=(24000,1,2):raise ValueError('Unexpected PCM format')
        return w.readframes(w.getnframes())


def context_check_valid(record, raw_path, profile):
    """Verify every provenance link and the unchanged target appearing twice."""
    ctx=record.get('qa',{}).get('contextCheck')
    if not ctx or ctx.get('status')!='passed' or ctx.get('asrWeightsSha256')!=MODEL_SHA:return False
    try:
        if ctx.get('targetRawSha256')!=sha(raw_path.read_bytes()):return False
        target=read_pcm(raw_path)
        if ctx.get('targetPcmSha256')!=sha(target):return False
        expected='. '.join(['come',record['spokenText'],'give',record['spokenText'],'come'])+'.'
        if ctx.get('expected')!=expected:return False
        if spoken_equivalents(words(ctx.get('qa',{}).get('transcript','')))!=spoken_equivalents(words(expected)):return False
        anchor_data={};sources=ctx.get('anchors',[])
        if len(sources)!=2 or {s.get('text') for s in sources}!={'come','give'}:return False
        for source in sources:
            word=source['text'];key=sha(word.encode());path=OUT/'raw'/profile['id']/f'{key}.wav'
            meta=OUT/'records'/profile['id']/f'{key}.json'
            if source.get('voiceId')!=profile['id'] or source.get('textKey')!=key:return False
            if source.get('rawSha256')!=sha(path.read_bytes()):return False
            anchor=json.loads(meta.read_text())
            if anchor.get('qaStatus')!='passed' or anchor.get('auditProblems') or anchor.get('originalText')!=word or anchor.get('spokenText')!=word:return False
            if anchor.get('qaVersion')!=QA_VERSION or anchor.get('asrWeightsSha256')!=MODEL_SHA or anchor.get('qaRulesSignature')!=qa_signature():return False
            if anchor.get('rawSha256')!=source['rawSha256'] or anchor.get('fingerprint')!=generation_fingerprint(profile,{'originalText':word,'spokenText':word}):return False
            if spoken_equivalents(words(anchor.get('qa',{}).get('transcript','')))!=spoken_equivalents([word]) or not clean_signal(signal(path)):return False
            anchor_data[word]=read_pcm(path)
        relative=ctx.get('file','')
        composite=(OUT/relative).resolve()
        if not composite.is_relative_to((OUT/'context-qa').resolve()):return False
        if sha(composite.read_bytes())!=ctx.get('compositeSha256'):return False
        actual=read_pcm(composite)
        rebuilt=(b'\0\0'*7200).join([anchor_data['come'],target,anchor_data['give'],target,anchor_data['come']])
        if actual!=rebuilt:return False
        return True
    except (OSError,ValueError,KeyError,TypeError,wave.Error):
        return False


def contextual_word_qa(path, profile, item):
    """Unprompted ASR support for short words; never modifies delivered audio."""
    if item.get('kind')!='word' or not clean_signal(signal(path)):return {'status':'unavailable'}
    signature=qa_signature()
    target=read_pcm(path);raw_sha=sha(path.read_bytes());anchor_data={};sources=[]
    for word in ('come','give'):
        key=sha(word.encode());source=OUT/'raw'/profile['id']/f'{key}.wav';meta=OUT/'records'/profile['id']/f'{key}.json'
        if not source.is_file() or not meta.is_file():return {'status':'unavailable'}
        r=json.loads(meta.read_text())
        if r.get('qaStatus')!='passed' or r.get('auditProblems') or r.get('originalText')!=word or sha(source.read_bytes())!=r.get('rawSha256') or not clean_signal(signal(source)):return {'status':'unavailable'}
        if r.get('qaVersion')!=QA_VERSION or r.get('asrWeightsSha256')!=MODEL_SHA or r.get('fingerprint')!=generation_fingerprint(profile,{'originalText':word,'spokenText':word}):return {'status':'unavailable'}
        if words(r.get('qa',{}).get('transcript',''))!=[word]:return {'status':'unavailable'}
        if r.get('qaRulesSignature')!=signature:
            r['qaRulesSignature']=signature;atomic_json(meta,r)
        anchor_data[word]=read_pcm(source);sources.append({'text':word,'textKey':key,'voiceId':profile['id'],'rawSha256':sha(source.read_bytes())})
    folder=OUT/'context-qa'/profile['id'];folder.mkdir(parents=True,exist_ok=True)
    composite=folder/f"{item['textKey']}-{raw_sha}.wav"
    pcm=(b'\0\0'*7200).join([anchor_data['come'],target,anchor_data['give'],target,anchor_data['come']])
    with wave.open(str(composite),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(pcm)
    expected='. '.join(['come',item['spokenText'],'give',item['spokenText'],'come'])+'.'
    q=transcribe(composite,expected);qa_signature()
    result={'status':q['status'],'method':'Unprompted contextual replay of the unchanged target PCM twice between verified same-voice anchors','file':str(composite.relative_to(OUT)),'compositeSha256':sha(composite.read_bytes()),'targetRawSha256':raw_sha,'targetPcmSha256':sha(target),'anchors':sources,'silenceSamplesBetweenClips':7200,'expected':expected,'qa':q,'asrWeightsSha256':MODEL_SHA}
    atomic_json(composite.with_suffix('.json'),result)
    return result


def audit_records(profiles,items):
    """Revalidate existing accepted output under current text, voice and QA rules."""
    by_voice={p['id']:p for p in profiles};by_text={i['textKey']:i for i in items}
    signature=qa_signature();summary={'checked':0,'passed':0,'review':[]}
    anchor_keys={sha(b'come'),sha(b'give')}
    paths=sorted((OUT/'records').glob('*/*.json'),key=lambda p:(p.stem not in anchor_keys,str(p)))
    for path in paths:
        r=json.loads(path.read_text());before=json.dumps(r,sort_keys=True)
        voice=by_voice.get(r.get('voiceId'));item=by_text.get(r.get('textKey'))
        if not voice or not item:raise ValueError(f'Out-of-snapshot asset record: {path}')
        raw=OUT/'raw'/voice['id']/f"{item['textKey']}.wav";mp3=OUT/'bundle'/f"voices/{voice['id']}/{item['textKey']}.mp3"
        problems=[]
        old_model=r.get('asrWeightsSha256')
        model_changed=bool(old_model and old_model!=MODEL_SHA)
        if model_changed:problems.append('asr-model-changed-retranscription-required')
        if r.get('originalText')!=item['originalText'] or r.get('spokenText')!=item['spokenText'] or r.get('fingerprint')!=generation_fingerprint(voice,item):problems.append('current-text-or-reference-mismatch')
        direction=required_pronunciation(item)
        if direction and direction not in r.get('requestFields',{}).get('instruction',''):problems.append('pronunciation-guidance-not-applied')
        if not raw.is_file() or sha(raw.read_bytes())!=r.get('rawSha256'):problems.append('raw-hash-mismatch')
        if not mp3.is_file() or sha(mp3.read_bytes())!=r.get('sha256'):problems.append('mp3-hash-mismatch')
        if not problems:
            sig=signal(raw);r['signal']=sig
            if not clean_signal(sig):problems.append('audio-boundary-or-clipping-review')
            legacy_first=(not r.get('contextCrop') and (r.get('generationMode') is None or (r.get('generationMode')=='word-batch-v1' and r.get('batchIndex')==0)))
            if legacy_first and sig['first10msRmsDbfs']>min(-45,sig['peakDbfs']-25):problems.append('unprotected-first-phoneme-review')
            has_context=bool(r.get('qa',{}).get('contextCheck'))
            context_valid=context_check_valid(r,raw,voice) if has_context else False
            if has_context and not context_valid:problems.append('context-proof-invalid')
            if spoken_equivalents(words(item['spokenText']))!=spoken_equivalents(words(r.get('qa',{}).get('transcript',''))) and not context_valid:problems.append('transcript-review')
        r['qaVersion']=QA_VERSION
        if not model_changed:
            r['qaRulesSignature']=signature;r['asrWeightsSha256']=MODEL_SHA
        r['qaStatus']='review' if problems else 'passed';r['auditProblems']=problems
        if json.dumps(r,sort_keys=True)!=before:atomic_json(path,r)
        summary['checked']+=1
        if problems:summary['review'].append({'voiceId':voice['id'],'textKey':item['textKey'],'text':item['originalText'],'problems':problems})
        else:summary['passed']+=1
    atomic_json(OUT/'audit-current.json',summary)
    return summary


def silence_cut(pcm,left,right):
    import numpy as np
    f=np.frombuffer(pcm,dtype='<i2').astype(float)/32768;sr=24000
    a=max(left['start']+.08,left['end']-.08);b=min(right['end']-.08,right['start']+.08)
    candidates=[]
    for center in range(round(a*sr),round(b*sr)+1,120):
        sample=f[max(0,center-480):min(len(f),center+480)]
        if len(sample):candidates.append((float(np.sqrt(np.mean(sample*sample))),center))
    if not candidates:raise ValueError('No gap between lead-in and requested text')
    rms,cut=min(candidates);db=20*math.log10(max(rms,1e-12));peak=20*math.log10(max(float(abs(f).max()),1e-12))
    if db>=min(-45,peak-32):raise ValueError(f'No clear lead-in silence: {db:.2f} dBFS')
    return int(cut),{'cutSample':int(cut),'cutSeconds':cut/sr,'rms40msDbfs':db}


def prefaced_audio(profile,item,seed):
    target=item['spokenText'];suffix='' if target[-1:] in '.?!' else '.'
    requested={**item,'spokenText':'Hello.\n\n'+target+suffix,'pronunciationKey':target.lower(),'generationInstruction':'Read the supplied entries separately in the reference voice. Pause for half a second after the first entry Hello, then read the remaining word or complete sentence. Natural General American pronunciation. Complete every word clearly. Speak only the supplied words, no additions or music.'}
    pcm,seconds,fields=request_audio(profile,requested,seed)
    folder=OUT/'context'/profile['id'];folder.mkdir(parents=True,exist_ok=True)
    full=folder/f"{item['textKey']}-{seed}.wav"
    with wave.open(str(full),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(pcm)
    q=transcribe(full,' '.join(requested['spokenText'].split()));ws=[w for s in q['segments'] for w in s['words']]
    if len(ws)<2 or words(ws[0]['word'])!=['hello']:raise ValueError('Lead-in not identified; refusing guessed crop')
    cut,info=silence_cut(pcm,ws[0],ws[1])
    proof={'requestFields':fields,'qa':q,'crop':info,'rawSha256':sha(full.read_bytes())}
    atomic_json(full.with_suffix('.json'),proof)
    return pcm[cut*2:],seconds,fields,{'leadIn':'Hello.','fullAudio':str(full.relative_to(OUT)),**info}


def recheck_word_records(profiles,items):
    by_voice={v['id']:v for v in profiles};by_key={i['textKey']:i for i in items};checked=0
    for path in (OUT/'records').glob('*/*.json'):
        record=json.loads(path.read_text());item=by_key[record['textKey']]
        if item['kind']!='word' or record.get('qaStatus')=='passed':continue
        if any(problem not in ('transcript-review','context-proof-invalid') for problem in record.get('auditProblems',[])):continue
        voice=by_voice[record['voiceId']];raw=OUT/'raw'/voice['id']/f"{item['textKey']}.wav"
        if not raw.exists() or sha(raw.read_bytes())!=record.get('rawSha256') or not clean_signal(signal(raw)):continue
        context=contextual_word_qa(raw,voice,item)
        if context.get('status')=='unavailable':continue
        record['qa']['contextCheck']=context;atomic_json(path,record);checked+=1
        print('CONTEXT_RECHECK',voice['id'],item['originalText'],context['status'],context['qa']['transcript'],flush=True)
    return checked


def register_voice(profile):
    """Use server's ephemeral hash cache, never create a named/saved voice."""
    with CACHE_LOCK:
        boundary='LocalReferenceCache20261110'
        reference=(OUT/profile['reference']['path']).read_bytes()
        assert sha(reference)==profile['reference']['sha256'],'Reference WAV changed'
        body=(f'--{boundary}\r\nContent-Disposition: form-data; name="ref_text"\r\n\r\n{profile["reference"]["text"]}\r\n--{boundary}\r\nContent-Disposition: form-data; name="ref_audio"; filename="reference-{profile["id"]}.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode()+reference+f'\r\n--{boundary}--\r\n'.encode()
        for attempt in range(8):
            try:
                req=urllib.request.Request('http://127.0.0.1:8137/v1/voices',data=body,headers={'Content-Type':f'multipart/form-data; boundary={boundary}'})
                with urllib.request.urlopen(req,timeout=120) as response:data=json.load(response)
                assert data['ref_text']==profile['reference']['text'] and data['saved'] is False
                CACHE_IDS[profile['id']]=data['id']
                atomic_json(OUT/'references'/f"{profile['id']}-cache.json",{'referenceSha256':profile['reference']['sha256'],'response':data})
                return data['id']
            except (urllib.error.URLError,TimeoutError,http.client.RemoteDisconnected):
                if attempt==7:raise
                time.sleep(min(15,2**attempt))


def request_audio(profile, item, seed):
    boundary = 'LocalPracticeAudio20261110'
    # A terminal period helps isolated-word EOS without adding spoken words.
    text = item['spokenText']
    if len(words(text)) == 1 and text[-1:] not in '.?!':
        text += '.'
    fields = {'text': text, 'instruction': item.get('generationInstruction','Speak only the provided English text in the same voice as the reference. Natural General American pronunciation, clear and conversational. No added words. No music.'), 'ref_text': profile['reference']['text'], 'cfg_scale': 1, 'seed': seed}
    guidance_path=OUT/'pronunciation-guidance.json'
    if guidance_path.exists():
        guidance=json.loads(guidance_path.read_text()).get(item.get('pronunciationKey',item['spokenText'].lower()))
        if guidance:fields['instruction']+=' '+guidance
    start = time.time()
    for attempt in range(9):
        try:
            cached=CACHE_IDS.get(profile['id'])
            if cached:fields['voice_id']=cached
            body = b''.join((f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n').encode() for k,v in fields.items())
            if not cached:
                body += (f'--{boundary}\r\nContent-Disposition: form-data; name="ref_audio"; filename="reference.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode() + (OUT/profile['reference']['path']).read_bytes()+b'\r\n'
            body += f'--{boundary}--\r\n'.encode()
            req = urllib.request.Request('http://127.0.0.1:8137/v1/audio/speech', data=body, headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
            with urllib.request.urlopen(req, timeout=600) as r:
                sr = int(r.headers.get('X-Sample-Rate', '24000'))
                pcm = r.read()
            assert sr == 24000 and len(pcm)%2 == 0 and len(pcm)>=9600, (sr,len(pcm))
            return pcm, round(time.time()-start,3), fields
        except urllib.error.HTTPError as e:
            detail=e.read().decode('utf8',errors='replace')[:300]
            if e.code==404 and cached and attempt<8:
                register_voice(profile);continue
            if e.code not in (400,409,429,502,503,504) or attempt == 8:
                raise RuntimeError(f'HTTP {e.code}: {detail}') from e
            delay=min(45, 2**attempt*2)
            print('SERVICE_RETRY', profile['id'], item['textKey'][:10], e.code, delay,detail, flush=True)
            time.sleep(delay)
        except (urllib.error.URLError,TimeoutError,http.client.RemoteDisconnected) as e:
            if attempt==8:raise
            print('NETWORK_RETRY',profile['id'],item['textKey'][:10],repr(e),flush=True)
            time.sleep(min(15,2**attempt))
    raise RuntimeError('Unreachable')


def encode(raw, target, sig):
    # Constant gain only. Cap peak and gain; no limiter/time/pitch processing.
    gain = min(12.0, -23.0-sig['rmsDbfs'], -2.0-sig['peakDbfs'])
    temp = target.with_suffix('.part.mp3')
    target.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run(['ffmpeg','-nostdin','-y','-v','error','-i',str(raw),'-af',f'volume={gain:.5f}dB','-ar','24000','-ac','1','-c:a','libmp3lame','-b:a','64k',str(temp)],check=True)
    subprocess.run(['ffmpeg','-nostdin','-v','error','-i',str(temp),'-f','null','-'],check=True, capture_output=True)
    temp.replace(target)
    return gain


def job(profile, item, retries):
    voice, key = profile['id'], item['textKey']
    meta = OUT/'records'/voice/f'{key}.json'
    raw = OUT/'raw'/voice/f'{key}.wav'
    mp3 = OUT/'bundle'/'voices'/voice/f'{key}.mp3'
    fingerprint = generation_fingerprint(profile,item)
    prior = json.loads(meta.read_text()) if meta.exists() else {}
    only_transcript_problems=all(p=='transcript-review' for p in prior.get('auditProblems',[]))
    if prior.get('fingerprint')==fingerprint and prior.get('qaStatus')=='review' and prior.get('qaVersion')==QA_VERSION and prior.get('asrWeightsSha256')==MODEL_SHA and only_transcript_problems and clean_signal(prior.get('signal',{'clippedSamples':1})) and raw.exists() and mp3.exists() and sha(raw.read_bytes())==prior.get('rawSha256') and sha(mp3.read_bytes())==prior.get('sha256'):
        qa=prior.get('qa',{})
        if spoken_equivalents(words(item['spokenText']))==spoken_equivalents(words(qa.get('transcript',''))):
            qa['status']='passed';qa['homophoneEquivalent']=True
            prior['qaStatus']='passed';prior['auditProblems']=[];prior['qaRulesSignature']=qa_signature();prior['qaReclassification']='Explicit identical-pronunciation spelling equivalence, original transcript and differences retained'
            atomic_json(meta,prior)
    context_ok=not prior.get('qa',{}).get('contextCheck') or (raw.exists() and context_check_valid(prior,raw,profile))
    if prior.get('fingerprint')==fingerprint and prior.get('qaStatus')=='passed' and not prior.get('auditProblems') and context_ok and prior.get('qaVersion')==QA_VERSION and prior.get('qaRulesSignature')==qa_signature() and raw.exists() and mp3.exists() and sha(raw.read_bytes())==prior.get('rawSha256') and sha(mp3.read_bytes())==prior.get('sha256'):
        return prior
    base = {**item,'voiceId':voice,'fingerprint':fingerprint,'referenceSha256':profile['reference']['sha256'],'path':f'voices/{voice}/{key}.mp3','format':'mp3','sampleRate':24000}
    raw.parent.mkdir(parents=True,exist_ok=True)
    attempt_offset=prior.get('attempt',0) if prior.get('fingerprint')==fingerprint else 0
    for attempt in range(retries+1):
        attempt_number=attempt_offset+attempt
        seed = int(sha(f'{voice}:{key}:{attempt_number}'.encode())[:8],16)&0x7fffffff
        try:
            start=time.time()
            pcm, generation_seconds, fields,crop=prefaced_audio(profile,item,seed)
            tmp=raw.with_suffix('.part.wav')
            with wave.open(str(tmp),'wb') as w:
                w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(pcm)
            sig=signal(tmp)
            qa=transcribe(tmp,item['spokenText'])
            supported=False
            if qa['status']!='passed' and clean_signal(sig) and item['kind']=='word':
                context=contextual_word_qa(tmp,profile,item)
                if context.get('status')!='unavailable':qa['contextCheck']=context
                supported=context_check_valid({**item,'qa':qa},tmp,profile)
            passed=(qa['status']=='passed' or supported) and clean_signal(sig)
            data={**base,'seed':seed,'attempt':attempt_number+1,'generationSeconds':generation_seconds,'requestFields':fields,'contextCrop':crop,'duration':sig['duration'],'signal':sig,'qa':qa,'qaStatus':'passed' if passed else 'review','qaVersion':QA_VERSION,'qaRulesSignature':qa_signature(),'asrWeightsSha256':MODEL_SHA,'rawSha256':sha(tmp.read_bytes())}
            if passed or attempt==retries:
                tmp.replace(raw)
                data['gainDb']=encode(raw,mp3,sig)
                data['sha256']=sha(mp3.read_bytes())
                data['bytes']=mp3.stat().st_size
                data['totalSeconds']=round(time.time()-start,3)
                atomic_json(meta,data)
                print('DONE',voice,item['itemKeys'][0],data['qaStatus'],sig['duration'],generation_seconds,qa['transcript'],flush=True)
                return data
            attempts=OUT/'attempts'/voice
            attempts.mkdir(parents=True,exist_ok=True)
            tmp.replace(attempts/f'{key}-{attempt_number+1}.wav')
            atomic_json(attempts/f'{key}-{attempt_number+1}.json',data)
            print('QA_RETRY',voice,item['itemKeys'][0],qa['differences'],sig['clippedSamples'],flush=True)
        except Exception as e:
            data={**base,'qaStatus':'failed','error':repr(e),'attempt':attempt_number+1}
            atomic_json(meta,data)
            print('ERROR',voice,item['itemKeys'][0],repr(e),flush=True)
            if attempt==retries:
                return data
            time.sleep(2)


def word_batch(profile, items, retries):
    """Generate vocabulary together, split only at measured silence, QA each clip."""
    import numpy as np
    voice=profile['id']
    batch_id=sha((voice+':hello-leadin-v2:'+':'.join(i['textKey'] for i in items)).encode())
    folder=OUT/'batches'/voice
    folder.mkdir(parents=True,exist_ok=True)
    raw=folder/f'{batch_id}.wav'
    work_items=[{'spokenText':'Hello','itemKeys':['non-delivered-lead-in']}]+items
    expected='. '.join(i['spokenText'] for i in work_items)+'.'
    request={'spokenText':expected,'textKey':batch_id,'generationInstruction':'Read each English vocabulary word clearly in the same voice as the reference. Pause briefly between each word, about half a second. Speak only the provided words, no extra words. Natural General American pronunciation.'}
    guidance_path=OUT/'pronunciation-guidance.json'
    if guidance_path.exists():
        guidance=json.loads(guidance_path.read_text())
        for item in items:
            if item['spokenText'].lower() in guidance:request['generationInstruction']+=' '+guidance[item['spokenText'].lower()]
    seed=int(batch_id[:8],16)&0x7fffffff
    try:
        prior_path=folder/f'{batch_id}.json'
        prior=json.loads(prior_path.read_text()) if prior_path.exists() else {}
        cached_fields=prior.get('requestFields',{})
        same_request=(cached_fields.get('text')==expected and cached_fields.get('instruction')==request['generationInstruction'] and cached_fields.get('seed')==seed and cached_fields.get('cfg_scale')==1)
        if raw.exists() and prior.get('rawSha256')==sha(raw.read_bytes()) and prior.get('referenceSha256')==profile['reference']['sha256'] and same_request:
            with wave.open(str(raw)) as w:pcm=w.readframes(w.getnframes())
            seconds=prior['generationSeconds'];fields=prior['requestFields'];qa=prior['qa']
        else:
            pcm,seconds,fields=request_audio(profile,request,seed)
            with wave.open(str(raw),'wb') as w:
                w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(pcm)
            qa=transcribe(raw,expected)
        ws=[w for segment in qa['segments'] for w in segment['words']]
        heard=[token for w in ws for token in words(w['word'])]
        # Equal word count permits per-position review; a bad word never invalidates
        # unrelated correct words, and each resulting clip gets a fresh ASR check.
        aligned=len(ws)==len(work_items) and words(ws[0]['word'])==['hello'] and all(len(words(w['word']))==1 for w in ws)
        detail={'id':batch_id,'voiceId':voice,'textKeys':[i['textKey'] for i in items],'referenceSha256':profile['reference']['sha256'],'requestFields':fields,'generationSeconds':seconds,'qa':qa,'rawSha256':sha(raw.read_bytes()),'aligned':aligned}
        if not aligned:
            atomic_json(folder/f'{batch_id}.json',detail)
            print('BATCH_FALLBACK_SEQUENCE',voice,batch_id[:8],qa['differences'],flush=True)
            return [job(profile,item,retries) for item in items]
        values=np.frombuffer(pcm,dtype='<i2');f=values.astype(float)/32768;sr=24000
        peak=20*math.log10(max(float(abs(f).max()),1e-12))
        threshold=min(-45,peak-32)
        boundaries=[0];checks=[]
        for n in range(len(ws)-1):
            a=max(ws[n]['start']+.08,ws[n]['end']-.08)
            b=min(ws[n+1]['end']-.08,ws[n+1]['start']+.08)
            candidates=[]
            for center in range(round(a*sr),round(b*sr)+1,120):
                sample=f[max(0,center-480):min(len(f),center+480)]
                if len(sample):candidates.append((float(np.sqrt(np.mean(sample*sample))),center))
            rms,cut=min(candidates) if candidates else (1.0,round((a+b)*sr/2))
            db=20*math.log10(max(rms,1e-12))
            checks.append({'index':n,'cutSample':int(cut),'rms40msDbfs':db,'thresholdDbfs':threshold,'passed':bool(db<threshold)})
            boundaries.append(int(cut))
        boundaries.append(len(values));detail['boundaries']=checks
        atomic_json(folder/f'{batch_id}.json',detail)
        results=[]
        for n,item in enumerate(work_items):
            if n==0:continue
            if spoken_equivalents(words(ws[n]['word']))!=spoken_equivalents(words(item['spokenText'])):
                print('BATCH_FALLBACK_WORD',voice,item['itemKeys'][0],ws[n]['word'],flush=True)
                results.append(job(profile,item,retries));continue
            if (n>0 and not checks[n-1]['passed']) or (n<len(work_items)-1 and not checks[n]['passed']):
                print('BATCH_FALLBACK_BOUNDARY',voice,item['itemKeys'][0],flush=True)
                results.append(job(profile,item,retries));continue
            key=item['textKey'];target=OUT/'raw'/voice/f'{key}.wav'
            target.parent.mkdir(parents=True,exist_ok=True)
            tmp=target.with_suffix('.part.wav')
            with wave.open(str(tmp),'wb') as w:
                w.setnchannels(1);w.setsampwidth(2);w.setframerate(sr);w.writeframes(values[boundaries[n]:boundaries[n+1]].tobytes())
            sig=signal(tmp);clip_qa=transcribe(tmp,item['spokenText'])
            supported=False
            if clip_qa['status']!='passed' and clean_signal(sig):
                context=contextual_word_qa(tmp,profile,item)
                if context.get('status')!='unavailable':clip_qa['contextCheck']=context
                supported=context_check_valid({**item,'qa':clip_qa},tmp,profile)
            if (clip_qa['status']!='passed' and not supported) or not clean_signal(sig):
                audit=folder/f'{batch_id}-clip-{n}.json'
                atomic_json(audit,{'item':item,'qa':clip_qa,'signal':sig})
                tmp.replace(folder/f'{batch_id}-clip-{n}.wav')
                print('BATCH_FALLBACK_CLIP',voice,item['itemKeys'][0],clip_qa['differences'],flush=True)
                results.append(job(profile,item,retries));continue
            tmp.replace(target)
            mp3=OUT/'bundle'/'voices'/voice/f'{key}.mp3'
            gain=encode(target,mp3,sig)
            fingerprint=generation_fingerprint(profile,item)
            record={**item,'voiceId':voice,'fingerprint':fingerprint,'referenceSha256':profile['reference']['sha256'],'path':f'voices/{voice}/{key}.mp3','format':'mp3','sampleRate':24000,'seed':seed,'attempt':1,'generationMode':'word-batch-v2-leadin','batchId':batch_id,'batchIndex':n-1,'batchClipStart':boundaries[n]/sr,'batchClipEnd':boundaries[n+1]/sr,'generationSeconds':seconds/len(items),'requestFields':fields,'duration':sig['duration'],'signal':sig,'qa':clip_qa,'qaStatus':'passed','qaVersion':QA_VERSION,'qaRulesSignature':qa_signature(),'asrWeightsSha256':MODEL_SHA,'rawSha256':sha(target.read_bytes()),'gainDb':gain,'sha256':sha(mp3.read_bytes()),'bytes':mp3.stat().st_size}
            atomic_json(OUT/'records'/voice/f'{key}.json',record)
            print('BATCH_DONE',voice,item['itemKeys'][0],sig['duration'],clip_qa['transcript'],flush=True)
            results.append(record)
        return results
    except Exception as error:
        print('BATCH_ERROR_FALLBACK',voice,batch_id[:8],repr(error),flush=True)
        atomic_json(folder/f'{batch_id}-error.json',{'error':repr(error),'items':items})
        return [job(profile,item,retries) for item in items]


def manifest(profiles, items):
    assets=[]
    signature=qa_signature()
    expected_items={i['textKey']:i for i in items};expected_voices={v['id']:v for v in profiles}
    for p in sorted((OUT/'records').glob('*/*.json')):
        r=json.loads(p.read_text())
        item=expected_items.get(r.get('textKey'));profile=expected_voices.get(r.get('voiceId'))
        valid_current=item and profile and r.get('originalText')==item['originalText'] and r.get('spokenText')==item['spokenText'] and r.get('fingerprint')==generation_fingerprint(profile,item)
        if valid_current and required_pronunciation(item) not in r.get('requestFields',{}).get('instruction',''):valid_current=False
        if valid_current and r.get('qa',{}).get('contextCheck') and not context_check_valid(r,OUT/'raw'/profile['id']/f"{item['textKey']}.wav",profile):valid_current=False
        if r.get('qaStatus')=='passed' and not r.get('auditProblems') and r.get('qaVersion')==QA_VERSION and r.get('qaRulesSignature')==signature and valid_current:
            assets.append({k:r[k] for k in ('textKey','originalText','spokenText','voiceId','path','sha256','duration','sampleRate','format','qaStatus','bytes')})
    previews=[]
    source=ROOT/'out/breeze-voices-20261110'
    original=json.loads((source/'manifest.json').read_text())['text']
    key=sha(original.encode())
    for p in profiles:
        path=f"previews/{p['id']}/{key}.mp3"
        target=OUT/'bundle'/path
        raw=source/p['rawFile']
        assert sha(raw.read_bytes())==p['rawSha256']
        qa=json.loads((source/f"qa-{p['id']}.json").read_text())
        assert qa['sha256']==p['rawSha256'] and words(qa['transcript'])==words(original)
        if not target.exists():encode(raw,target,signal(raw))
        previews.append({'textKey':key,'originalText':original,'spokenText':original,'voiceId':p['id'],'path':path,'sha256':sha(target.read_bytes()),'duration':p['duration'],'sampleRate':24000,'format':'mp3','qaStatus':'passed','bytes':target.stat().st_size})
    data={'manifestVersion':1,'generatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'scope':'personal-use public practice content','voices':[{'id':p['id'],'name':p['name'],'referenceSha256':p['reference']['sha256']} for p in profiles],'expectedTexts':len(items),'expectedAssets':len(items)*len(profiles),'assets':assets,'previews':previews}
    atomic_json(OUT/'bundle'/'manifest.json',data)
    return data


def main():
    global OUT, MODEL
    parser=argparse.ArgumentParser()
    parser.add_argument('--mode',choices=['pilot','batch-pilot','all','manifest','references','audit','recheck'],default='pilot')
    parser.add_argument('--workers',type=int,choices=[1,2,3,4],default=1)
    parser.add_argument('--retries',type=int,default=2)
    parser.add_argument('--word-batches',action='store_true')
    parser.add_argument('--output-dir',type=Path,default=OUT,help='Local output directory containing voice-profiles.json and reference WAVs')
    parser.add_argument('--asr-model',default=MODEL,help='Local MLX Whisper model directory; defaults to BREEZE_ASR_MODEL or sibling project cache')
    args=parser.parse_args()
    OUT=args.output_dir.expanduser().resolve()
    MODEL=str(Path(args.asr_model).expanduser().resolve())
    OUT.mkdir(parents=True,exist_ok=True)
    profiles=json.loads((OUT/'voice-profiles.json').read_text())['voices']
    items=export_content()
    if args.mode in ('manifest','audit'):
        audit_records(profiles,items)
        print(json.dumps({k:v for k,v in manifest(profiles,items).items() if k!='assets'},ensure_ascii=False));return
    if args.mode=='recheck':
        audit_records(profiles,items);recheck_word_records(profiles,items)
        audit=audit_records(profiles,items);manifest(profiles,items)
        print('RECHECK_COMPLETE',audit['checked'],audit['passed'],len(audit['review']),flush=True);return
    if args.mode=='references':
        for p in profiles:
            q=transcribe(OUT/p['reference']['path'],p['reference']['text'])
            atomic_json(OUT/'references'/f"{p['id']}-qa.json",q)
            print(p['id'],q['status'],q['transcript'],flush=True)
            if q['status']!='passed':raise ValueError('Reference crop mismatch')
        return
    audit=audit_records(profiles,items)
    print('STARTUP_AUDIT',audit['checked'],audit['passed'],len(audit['review']),flush=True)
    if args.mode=='all' and audit['review']:
        recheck_word_records(profiles,items)
        audit=audit_records(profiles,items)
        print('AFTER_CONTEXT_RECHECK',audit['checked'],audit['passed'],len(audit['review']),flush=True)
    for profile in profiles:register_voice(profile)
    if args.mode=='batch-pilot' or (args.mode=='all' and args.word_batches):
        started=time.time();completed=0;tasks=[];last_manifest_count=0;last_manifest_time=started
        if args.mode=='batch-pilot':
            tasks=[('batch',p,items[35:45]) for p in profiles]
            total=50
        else:
            pending={}
            for p in profiles:
                pending[p['id']]=[]
                for item in items:
                    record=OUT/'records'/p['id']/f"{item['textKey']}.json"
                    r=json.loads(record.read_text()) if record.exists() else {}
                    audio=OUT/'bundle'/r.get('path','nonexistent')
                    raw=OUT/'raw'/p['id']/f"{item['textKey']}.wav"
                    expected_fingerprint=generation_fingerprint(p,item)
                    if r.get('qaStatus')=='passed' and not r.get('auditProblems') and r.get('qaVersion')==QA_VERSION and r.get('fingerprint')==expected_fingerprint and audio.is_file() and raw.is_file() and sha(audio.read_bytes())==r.get('sha256') and sha(raw.read_bytes())==r.get('rawSha256'):
                        completed+=1;continue
                    if item['kind']=='word':pending[p['id']].append(item)
                    else:tasks.append(('single',p,item))
            batches=[]
            max_words=max(len(v) for v in pending.values())
            for start in range(0,max_words,10):
                for p in profiles:
                    group=pending[p['id']][start:start+10]
                    if group:batches.append(('batch',p,group))
            tasks=batches+tasks;total=len(items)*len(profiles)
        def run(task):
            mode,p,payload=task
            return word_batch(p,payload,args.retries) if mode=='batch' else [job(p,payload,args.retries)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures=[pool.submit(run,task) for task in tasks]
            for future in concurrent.futures.as_completed(futures):
                records=future.result();completed+=len(records)
                atomic_json(OUT/'progress.json',{'mode':args.mode,'wordBatches':True,'completed':completed,'total':total,'elapsedSeconds':round(time.time()-started,1),'last':{'voice':records[-1]['voiceId'],'textKey':records[-1]['textKey'],'status':records[-1]['qaStatus']}})
                if completed-last_manifest_count>=25 or time.time()-last_manifest_time>=30:
                    manifest(profiles,items)
                    last_manifest_count=completed;last_manifest_time=time.time()
                print('PROGRESS_BATCH',completed,total,round(time.time()-started),flush=True)
        audit_records(profiles,items)
        m=manifest(profiles,items)
        all_records=[json.loads(p.read_text()) for p in (OUT/'records').glob('*/*.json')]
        summary={'mode':args.mode,'wordBatches':True,'elapsedSeconds':round(time.time()-started,1),'passedAssets':len(m['assets']),'review':[{'voiceId':r['voiceId'],'textKey':r['textKey'],'text':r['originalText'],'status':r['qaStatus']} for r in all_records if r['qaStatus']!='passed']}
        atomic_json(OUT/f'{args.mode}-summary.json',summary)
        print('COMPLETE',json.dumps(summary,ensure_ascii=False),flush=True)
        return
    if args.mode=='pilot':
        selected=['word-0001','sentence-0239','sentence-0263','cet6-e05-s04']
        # First source word is used if key naming differs.
        pilot=[items[0]]+[i for i in items if any(k in selected[1:] for k in i['itemKeys'])]
    else:pilot=items
    tasks=[(p,i) for i in pilot for p in profiles]
    done=0;start=time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures=[pool.submit(job,p,i,args.retries) for p,i in tasks]
        for f in concurrent.futures.as_completed(futures):
            result=f.result();done+=1
            atomic_json(OUT/'progress.json',{'mode':args.mode,'completed':done,'total':len(tasks),'elapsedSeconds':round(time.time()-start,1),'last':{'voice':result['voiceId'],'textKey':result['textKey'],'status':result['qaStatus']}})
            if done%25==0:
                manifest(profiles,items)
                print('PROGRESS',done,len(tasks),round(time.time()-start),flush=True)
    audit_records(profiles,items)
    m=manifest(profiles,items)
    records=[json.loads(p.read_text()) for p in (OUT/'records').glob('*/*.json')]
    summary={'mode':args.mode,'jobs':len(tasks),'elapsedSeconds':round(time.time()-start,1),'passedAssets':len(m['assets']),'review':[{'voiceId':r['voiceId'],'textKey':r['textKey'],'text':r['originalText'],'status':r['qaStatus']} for r in records if r['qaStatus']!='passed']}
    atomic_json(OUT/f'{args.mode}-summary.json',summary)
    print('COMPLETE',json.dumps(summary,ensure_ascii=False),flush=True)


if __name__=='__main__':
    main()
