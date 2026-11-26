from pathlib import Path
import sys,shutil
root=Path(sys.argv[1]);here=Path(__file__).resolve().parent
for d in ['installer','downloads']:shutil.copytree(here/d,root/d,dirs_exist_ok=True)
shutil.copy2(here/'smk-companion.css',root/'smk-companion.css')
p=root/'index.html';s=p.read_text();anchor='<section class="shell section community-panel" id="support"'
i=s.find(anchor)
if i<0:i=s.index('</main>')
s=s[:i]+(here/'section.html').read_text()+s[i:]
s=s.replace('Install JAZZY <span>→</span></a>','Install JAZZY <span>→</span></a><a class="button" href="#smk37">SMK-37 PRO <span>↓</span></a>',1)
s=s.replace('</head>','<link rel="stylesheet" href="smk-companion.css?v=20261126.1"></head>');p.write_text(s)
