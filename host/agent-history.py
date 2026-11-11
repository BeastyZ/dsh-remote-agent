import base64, hashlib, json, os, re, subprocess, sys

PAGE_LIMIT = 128 * 1024
HARD_LIMIT = 1024 * 1024
SOURCE = 'kimi-code'

def response(messages=None, source_id=None, before=0, more=False, complete=False, available=True, reason=None):
    out = {'ok': True, 'available': available, 'messages': messages or [], 'source': SOURCE,
           'sourceId': source_id, 'before': before, 'hasMore': more, 'complete': complete}
    if reason: out['reason'] = reason
    return out

def norm_path(p):
    return os.path.normpath(str(p or ''))

def source_id(session_id, cwd):
    return 'kimi:' + hashlib.sha256((session_id + '\0' + norm_path(cwd)).encode()).hexdigest()[:24]

def read_index(home):
    path = os.path.join(home, '.kimi-code', 'session_index.jsonl')
    rows = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                try:
                    x = json.loads(line)
                    if isinstance(x, dict) and x.get('sessionId') and x.get('sessionDir') and x.get('workDir'):
                        rows[(str(x['sessionId']), norm_path(x['workDir']))] = x
                except Exception: pass
    except (OSError, UnicodeError): pass
    return list(rows.values())

def capture(tmux, name):
    try:
        p = subprocess.run([tmux, '-L', 'dsh-remote-agent', 'capture-pane', '-p', '-S', '-', '-t', name], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        return p.stdout if p.returncode == 0 else ''
    except Exception: return ''

def wire_path(home, row):
    root = os.path.realpath(os.path.join(home, '.kimi-code', 'sessions'))
    candidate = os.path.realpath(os.path.join(str(row['sessionDir']), 'agents', 'main', 'wire.jsonl'))
    if not candidate.startswith(root + os.sep) or not os.path.isfile(candidate): return None
    return candidate

def text_events(path):
    out = []
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                try: ev = json.loads(line)
                except Exception: continue
                if not isinstance(ev, dict) or ev.get('type') != 'agent.message.appended': continue
                msg = ev.get('message') or {}
                body = msg.get('message') or {}
                role = body.get('role')
                meta = msg.get('meta') or {}
                src = meta.get('source')
                if (role, src) not in (('user', 'input'), ('assistant', 'llm')): continue
                chunks = body.get('content') or []
                text = ''.join(str(c.get('text', '')) for c in chunks if isinstance(c, dict) and c.get('type') == 'text')
                if text: out.append({'role': role, 'text': text})
    except (OSError, UnicodeError): return []
    return out

def select(rows, home, cwd, tmux_path, remote_name, pane):
    exact = [r for r in rows if norm_path(r.get('workDir')) == norm_path(cwd)]
    if not exact: return None, 'no matching workspace session'
    clean = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', pane or '')
    # Score visible nontrivial fragments against exported text. This binds the
    # record to the current plugin-owned pane without guessing by recency.
    fragments = set(x.strip() for x in clean.splitlines() if len(x.strip()) >= 24)
    scored = []
    for row in exact:
        wp = wire_path(home, row)
        if not wp: continue
        events = text_events(wp)
        hay = '\n'.join(x['text'] for x in events)
        score = sum(1 for f in fragments if f in hay)
        scored.append((score, row, wp, events))
    scored.sort(key=lambda x: x[0], reverse=True)
    if not scored or scored[0][0] < 3: return None, 'current pane does not identify a Kimi record'
    if len(scored) > 1 and scored[1][0] > 0 and scored[0][0] - scored[1][0] < 2: return None, 'ambiguous Kimi records'
    return scored[0], None

def main():
    try: req = json.load(sys.stdin)
    except Exception: print(json.dumps(response(available=False, complete=False, reason='invalid-request'))); return
    cwd = str(req.get('cwd') or '')
    tmux_path = str(req.get('tmuxPath') or '')
    remote_name = str(req.get('remoteName') or '')
    if not cwd or not tmux_path or not remote_name:
        print(json.dumps(response(available=False, complete=False, reason='unsupported'))); return
    home = os.path.expanduser('~')
    rows = read_index(home)
    pane = capture(tmux_path, remote_name)
    chosen = None
    reason = None
    sid = req.get('sourceId')
    if sid:
        for row in rows:
            if source_id(str(row.get('sessionId')), cwd) == str(sid) and norm_path(row.get('workDir')) == norm_path(cwd):
                wp = wire_path(home, row)
                if wp: chosen = (1, row, wp, text_events(wp))
                break
        if chosen is None: reason = 'source session no longer matches workspace'
    else:
        chosen, reason = select(rows, home, cwd, tmux_path, remote_name, pane)
    if chosen is None:
        print(json.dumps(response(source_id=sid, available=False, complete=False, reason=reason or 'unavailable'))); return
    _, row, _, messages = chosen
    sid = source_id(str(row['sessionId']), cwd)
    for item in messages:
        if len(item['text'].encode('utf-8')) > HARD_LIMIT: print(json.dumps(response(source_id=sid, available=True, complete=False, reason='message-too-large'))); return
    total = len(messages)
    end = total if req.get('before') is None else max(0, min(total, int(req.get('before'))))
    start = end
    used = 0
    while start > 0:
        n = len(messages[start - 1]['text'].encode('utf-8'))
        if used and used + n > PAGE_LIMIT: break
        if not used and n > PAGE_LIMIT: used = n; start -= 1; break
        used += n; start -= 1
    page = messages[start:end]
    print(json.dumps(response(page, sid, start, start > 0, start == 0), ensure_ascii=False))

if __name__ == '__main__': main()
