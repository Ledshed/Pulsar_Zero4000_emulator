# Builds rdm/index.html from rdm/_template.html, reusing the bench, environment map, pattern list,
# info panel and scope dragging from the DMX page so both pages stay in step.
import pathlib
root = pathlib.Path(__file__).resolve().parent
src = (root.parent / 'dmx512' / 'index.html').read_text(encoding='utf-8').split('\n')
L = lambda a, b: '\n'.join(src[a - 1:b])
def check(line, text):
    assert src[line - 1].startswith(text), (line, src[line - 1][:60])
check(4, '<style>'); check(11, '/* Layout'); check(112, '</style>'); check(184, '  const OFF = {'); check(229, '  window.__DMX_PATTERNS')
check(292, '  // the bench'); check(330, '  const pcbMat'); check(340, '  const envTex'); check(350, '  const chrome')
check(687, '  (() => {'); check(708, '  })();'); check(769, '  (() => {'); check(795, '  })();')
head = L(1, 10).replace('DMX512 Slot Stream 3D', 'RDM Talkback 3D')
t = (root / '_template.html').read_text(encoding='utf-8')
for k, v in {'CSS': L(11, 111), 'PATTERNS': L(184, 228), 'BENCH': L(292, 329), 'ENV': L(340, 350), 'INFO': L(687, 708), 'SCOPEDRAG': L(769, 795)}.items():
    assert t.count('{{' + k + '}}') == 1, k
    t = t.replace('{{' + k + '}}', v)
(root / 'index.html').write_text(head + '\n' + t, encoding='utf-8')
print('built', len(head + t))
