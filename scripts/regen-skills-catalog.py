import json, os, re, glob

HOME = os.path.expanduser('~')
WS = HOME + '/.local/share/vellum/assistants/vellum/.vellum/workspace'
PKB = WS + '/pkb'
SRC = HOME + '/vellum-assistant/assistant/src'
BUNDLED = SRC + '/config/bundled-skills'
BUNDLE_CAT = HOME + '/vellum-assistant/skills'
BT = chr(96)

# Single source of truth for always-on skills: config.json
cfg = json.load(open(WS + '/config.json'))
PREACT = cfg.get('skills', {}).get('defaultPreactivated', [])

desc = {}

def fm_desc(path):
    if os.path.exists(path):
        m = re.search(r'^description:\s*(.+)$', open(path).read(), re.M)
        if m:
            return m.group(1).strip().strip('"')
    return ''

# 1) Bundled compiled-in skills (messaging, schedule, contacts, ...)
if os.path.isdir(BUNDLED):
    for d in sorted(os.listdir(BUNDLED)):
        p = BUNDLED + '/' + d + '/SKILL.md'
        if os.path.exists(p):
            desc[d] = fm_desc(p)

# 2) First-party catalog.json skills
cat = json.load(open(BUNDLE_CAT + '/catalog.json'))
for s in cat['skills']:
    desc.setdefault(s['id'], s.get('description', '').strip())
    if not desc.get(s['id']):
        desc[s['id']] = s.get('description', '').strip()

# 3) Workspace-installed skills from SKILLS.md
inst = []
sm = WS + '/skills/SKILLS.md'
if os.path.exists(sm):
    for line in open(sm):
        t = line.strip()
        if t.startswith('- '):
            inst.append(t[2:].strip())

all_ids = sorted(set(list(desc.keys()) + inst + PREACT))

def resolve_desc(sid):
    if desc.get(sid):
        return desc[sid]
    for p in [BUNDLED + '/' + sid + '/SKILL.md',
              BUNDLE_CAT + '/' + sid + '/SKILL.md',
              WS + '/skills/' + sid + '/SKILL.md']:
        d = fm_desc(p)
        if d:
            return d
    return '(installed skill)'

for sid in all_ids:
    desc[sid] = resolve_desc(sid)

def bullet(sid):
    return '- ' + BT + sid + BT + ' — ' + (desc.get(sid) or '(installed skill)')

out = ['# Skills Catalog', '',
       '_Auto-generated index of every skill available to you — this is the authoritative list of your capabilities. Regenerate with scripts/regen-skills-catalog.py when skills or skills.defaultPreactivated change._',
       '',
       '## Always-on skills (their tools are already loaded — call the tools directly, no skill_load needed)',
       '']
for sid in PREACT:
    out.append(bullet(sid))
out += ['',
        '## Load-on-demand skills (call skill_load with the id first, then use the skill tools)',
        '']
for sid in all_ids:
    if sid in PREACT:
        continue
    out.append(bullet(sid))
out.append('')
open(PKB + '/skills-catalog.md', 'w').write('\n'.join(out))
print('Wrote pkb/skills-catalog.md: %d skills (%d always-on: %s)' % (len(all_ids), len(PREACT), ', '.join(PREACT)))

ai = PKB + '/_autoinject.md'
a = open(ai).read()
if 'skills-catalog.md' not in a:
    if not a.endswith('\n'):
        a += '\n'
    a += 'skills-catalog.md\n'
    open(ai, 'w').write(a)
    print('Added skills-catalog.md to _autoinject.md')
else:
    print('_autoinject.md already lists skills-catalog.md')
