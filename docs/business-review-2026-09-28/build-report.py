"""Render the written audit into a standalone HTML file; no external dependencies."""
from pathlib import Path
import base64
import html
import re

ROOT = Path(__file__).resolve().parent
source = (ROOT / "report.md").read_text(encoding="utf-8")

def inline(value):
    value = html.escape(value)
    def link(match):
        label, url = match.group(1), html.unescape(match.group(2))
        if url.startswith("../../") or url == "../security.md":
            return '<code title="Путь относительно папки отчёта">' + label + '</code>'
        return '<a href="' + html.escape(url, quote=True) + '">' + label + '</a>'
    value = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link, value)
    value = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', value)
    return re.sub(r'`([^`]+)`', r'<code>\1</code>', value)

lines, output, toc = source.splitlines(), [], []
i, section = 0, 0
while i < len(lines):
    line = lines[i]
    if not line.strip():
        i += 1
        continue
    heading = re.match(r'^(#{1,3}) (.*)', line)
    picture = re.match(r'^!\[([^\]]+)\]\(([^)]+)\)$', line)
    if heading:
        level, title = len(heading[1]), heading[2]
        if level == 2:
            section += 1
            toc.append((f'section-{section}', title))
        ident = f' id="section-{section}"' if level == 2 else ''
        risk = ' class="risk-title"' if title.startswith('P0') else ''
        output.append(f'<h{level}{ident}{risk}>{inline(title)}</h{level}>')
        i += 1
    elif picture:
        path = ROOT / picture[2]
        encoded = base64.b64encode(path.read_bytes()).decode('ascii')
        mobile = ' mobile' if 'mobile' in path.name else ''
        output.append(f'<figure class="capture{mobile}"><img loading="lazy" src="data:image/png;base64,{encoded}" alt="{html.escape(picture[1])}"><figcaption>{html.escape(path.name)} · фактический локальный интерфейс</figcaption></figure>')
        i += 1
    elif line.startswith('|'):
        rows = []
        while i < len(lines) and lines[i].startswith('|'):
            cells = [cell.strip() for cell in lines[i].strip('|').split('|')]
            if not all(re.fullmatch(r'[:\- ]+', cell) for cell in cells):
                rows.append(cells)
            i += 1
        head = '<thead><tr>' + ''.join('<th scope="col">'+inline(c)+'</th>' for c in rows[0])+'</tr></thead>'
        body = '<tbody>' + ''.join('<tr>'+''.join('<td>'+inline(c)+'</td>' for c in row)+'</tr>' for row in rows[1:])+'</tbody>'
        output.append('<div class="table-wrap"><table>'+head+body+'</table></div>')
    elif re.match(r'^(?:- |\d+\. )', line):
        ordered = bool(re.match(r'^\d+\.', line))
        tag, items = ('ol' if ordered else 'ul'), []
        while i < len(lines) and re.match(r'^(?:- |\d+\. )', lines[i]):
            items.append('<li>'+inline(re.sub(r'^(?:- |\d+\. )', '', lines[i]))+'</li>')
            i += 1
        output.append('<'+tag+'>'+''.join(items)+'</'+tag+'>')
    else:
        paragraph = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r'^(?:#|\||!\[|- |\d+\. )', lines[i]):
            paragraph.append(lines[i])
            i += 1
        output.append('<p>'+inline(' '.join(paragraph))+'</p>')

style = """
:root{--ink:#1a1a2e;--teal:#0d7377;--soft:#eaf5f4;--gray:#606773;--line:#dce3e7;--red:#a5293c;--gold:#805c12}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:#fff;color:var(--ink);font:17px/1.75 system-ui,-apple-system,Segoe UI,sans-serif}a{color:var(--teal);text-underline-offset:3px}a:focus-visible,input:focus-visible{outline:3px solid #14a3a8;outline-offset:4px}header{border-top:7px solid var(--teal);background:#f4f8f8;padding:36px max(24px,calc((100vw - 1240px)/2)) 40px}.overline{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;font-weight:750;color:var(--teal)}.decision{font-size:clamp(26px,3vw,42px);line-height:1.25;letter-spacing:-1px;max-width:950px;margin:16px 0}.lead{max-width:880px;color:var(--gray);font-size:18px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:28px}.stat{padding:18px;background:white;border:1px solid var(--line);border-radius:10px}.stat strong{display:block;font-size:30px;line-height:1.3}.stat span{font-size:13px;color:var(--gray)}.layout{max-width:1288px;margin:auto;display:grid;grid-template-columns:245px minmax(0,1fr);gap:54px;padding:40px 24px}aside{align-self:start;position:sticky;top:24px;max-height:92vh;overflow:auto;font-size:13px}aside nav a{display:block;text-decoration:none;padding:9px 8px;border-bottom:1px solid #eef1f3}aside nav a:hover{background:var(--soft)}.aside-note{margin-top:20px;color:var(--gray);font-size:12px}main{min-width:0}h1{font-size:32px;line-height:1.3;margin:0 0 22px;letter-spacing:-.6px}h2{font-size:27px;line-height:1.3;margin:58px 0 20px;padding-top:18px;border-top:2px solid var(--line);letter-spacing:-.4px}h3{font-size:21px;line-height:1.45;margin:34px 0 14px}p{margin:14px 0}li{margin:10px 0}ul,ol{padding-left:25px}.risk-title{border-left:4px solid var(--red);padding:14px 18px;background:#fff3f3;border-radius:0 8px 8px;color:#842333}code{font-size:.87em;background:#f0f3f5;border-radius:4px;padding:2px 5px;overflow-wrap:anywhere}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:9px;margin:23px 0}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.6}td,th{text-align:left;vertical-align:top;padding:14px;border-bottom:1px solid var(--line)}th{background:var(--soft)}tr:last-child td{border-bottom:0}.capture{padding:12px;margin:22px 0;background:#f1f5f5;border:1px solid var(--line);border-radius:12px}.capture img{display:block;max-width:100%;height:auto;margin:auto;border-radius:6px}.capture.mobile img{max-width:350px;width:100%}figcaption{font-size:12px;color:var(--gray);margin-top:9px;text-align:center}.calculator{padding:24px;border:1px solid #b2d6d3;border-radius:12px;background:#f5fbfa;margin:34px 0}.calculator h2{border:0;margin:0;padding:0;font-size:24px}.fields{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:20px 0}.fields label{font-size:13px;font-weight:600}.fields input{display:block;width:100%;font:inherit;margin-top:6px;padding:10px;border:1px solid #9eafaf;border-radius:6px;background:#fff}.calc-result{font-size:16px}.muted{color:var(--gray);font-size:13px}.badge{display:inline-block;color:var(--gold);background:#fff4d9;padding:3px 9px;border-radius:5px;font-size:12px;font-weight:650}footer{max-width:1240px;margin:0 auto;padding:25px 24px 45px;border-top:1px solid var(--line);font-size:13px;color:var(--gray)}@media(max-width:950px){.layout{grid-template-columns:1fr;gap:18px}aside{position:static;max-height:none}aside nav{display:flex;gap:8px;flex-wrap:wrap}aside nav a{padding:6px 10px;border:1px solid var(--line);border-radius:5px}aside .aside-note{display:none}}@media(max-width:600px){body{font-size:16px}.stats{grid-template-columns:1fr 1fr}.fields{grid-template-columns:1fr}.layout{padding:25px 18px}h1{font-size:26px}h2{font-size:24px}header{padding:25px 18px}.stat strong{font-size:26px}}@media print{aside,.calculator{display:none}.layout{display:block;max-width:none;padding:0}header{padding:20px}.stats{display:none}body{font-size:11pt}.capture img{max-height:150mm}.table-wrap{overflow:visible}h2,h3{break-after:avoid}figure,tr{break-inside:avoid}a{color:inherit}}
"""
calculator = """<section class="calculator" aria-labelledby="calc-title"><span class="badge">Сценарий, не прогноз</span><h2 id="calc-title">Сколько клиентов покрывают сервер?</h2><p class="muted">Измените допущения. Результат не включает рекламу, налоги, возвраты, поддержку и переменные расходы. Для Stars нужен фактический чистый доход после вывода.</p><div class="fields"><label>Сервер, $/месяц<input id="server-cost" type="number" min="0" step="1" value="10"></label><label>Условный курс, сум/$<input id="fx-rate" type="number" min="1" step="1" value="12000"></label><label>Удержания, % от цены<input id="fee-rate" type="number" min="0" max="99" step="1" value="0"></label></div><div id="calc-result" class="calc-result" aria-live="polite"></div><p class="muted">12 000 сум/$ и 0% удержаний — исходные допущения для иллюстрации, не текущие котировки и не реальные комиссии.</p></section>"""
script = """'use strict';
const fields=['server-cost','fx-rate','fee-rate'].map(id=>document.getElementById(id));
function recalc(){const values=fields.map(e=>Number(e.value));const [server,fx,fee]=values;const result=document.getElementById('calc-result');if(fields.some(e=>e.value===''||!e.validity.valid)||values.some(v=>!Number.isFinite(v))||server<0||fx<=0||fee<0||fee>=100){result.textContent='Введите допустимые числа: стоимость от 0, курс выше 0, удержания от 0 до 99%.';return;}const plans=[['Базовый',20000],['Стандарт',50000],['Профи',75000]];result.textContent=plans.map(([name,price])=>`${name}: ${Math.ceil(server*fx/(price*(1-fee/100)))} платящих клиентов`).join(' · ');}
fields.forEach(field=>field.addEventListener('input',recalc));recalc();
"""
navigation = ''.join(f'<a href="#{ident}">{html.escape(title)}</a>' for ident, title in toc)
document = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Elonbot — бизнес-обзор · 28.09.2026</title><style>'+style+'</style></head><body>'
document += '<header><div class="overline">Elonbot · решение перед рекламой · 28 сентября 2026</div><div class="decision">Сначала подтвердить допустимость и пользу. Затем покупать трафик.</div><p class="lead">Рабочий продукт уже есть. Сейчас рост ограничивают схема подключения, путь к первой публикации и непроверенная готовность платить.</p><div class="stats"><div class="stat"><strong>25</strong><span>зарегистрированных — со слов владельца</span></div><div class="stat"><strong>0</strong><span>пользуются сейчас — со слов владельца</span></div><div class="stat"><strong>$10</strong><span>сервер в месяц — допущение</span></div><div class="stat"><strong>5 → 3 → 2</strong><span>участники → первый результат → повтор; ориентир пилота</span></div></div></header>'
document += '<div class="layout"><aside><nav aria-label="Содержание отчёта">'+navigation+'</nav><div class="aside-note">Факты: код и локальные проверки.<br>Исходные данные: владелец.<br>Правила: ссылки на первоисточники.<br>Гипотезы: отмечены в тексте.</div></aside><main>' + '\n'.join(output) + calculator + '</main></div>'
document += '<footer>The Business Engineer · Gennaro Cuofano — метод анализа. Product Design — аудит текущего интерфейса. Подготовлено по рабочей версии проекта; приложение не изменялось.</footer><script>'+script+'</script></body></html>'
(ROOT / 'report.html').write_text(document, encoding='utf-8')
assert document.count('data:image/png;base64,') == 7
assert document.count('<h1>') == 1
assert len(toc) == 9
print(f'HTML saved: {len(document.encode("utf-8")):,} bytes; 7 embedded screenshots; {len(toc)} sections')
