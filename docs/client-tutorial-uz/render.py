"""Deterministic illustrated tutorial. Real button labels, synthetic demo data.
Run: python render.py --ffmpeg PATH_TO_FFMPEG
Requires Pillow. Never connects to Telegram or loads application secrets.
"""
from pathlib import Path
import argparse
import json
import math
import subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent.parent
UZ = json.loads((APP / 'app/uz.json').read_text(encoding='utf-8'))
W, H, FPS = 720, 1280, 24
PAPER, INK, GREEN, MUTED, LINE = '#F7F8F2', '#183E32', '#245940', '#65726B', '#DCE2D7'
LIME, WHITE, CHAT, BLUE = '#D5EF83', '#FFFFFF', '#EDF2E9', '#236B80'
FONTS = Path('C:/Windows/Fonts')

def font(size, bold=False):
    return ImageFont.truetype(str(FONTS / ('segoeuib.ttf' if bold else 'segoeui.ttf')), size)

def label(group, key):
    return UZ[group][key].replace('⏸ ', '').replace('▶️ ', '').replace('🔄 ', '').replace('📖 ', '').replace('⚙️ ', '')

SCENES = [
    ('intro', 6, "Bir marta tayyorlang.", "E'loningizni tayyorlang. Guruhlar va vaqtni tanlang. Qolganini bot bajaradi."),
    ('language', 7, "Botni oching", "@elonyuborishbot ni oching. Start tugmasini, so'ng «O'zbekcha davom etish»ni bosing."),
    ('ready', 5, "Boshlashdan oldin", "Bu videoda Telegram akkaunti oldindan ulangan. Keyingi qadam — guruhlarni tanlash."),
    ('groups_menu', 6, "Guruhlarni qo'shing", "«Guruhlar» bo'limini oching va «Guruh qo'shish» tugmasini bosing."),
    ('groups_app', 9, "Kerakli guruhni ulang", "A'zo bo'lgan va e'lon berishga ruxsat etilgan guruhni tanlang. «Ulash», so'ng «Botga qaytish»ni bosing."),
    ('create', 5, "Yangi e'lon yarating", "Botga qayting. «E'lonlarim» → «E'lon yaratish»ni tanlang."),
    ('text', 7, "Matnni yuboring", "E'lon matni va aloqa ma'lumotlarini yuboring. Rasmsiz e'lon uchun «Davom etish»ni bosing."),
    ('photos', 10, "Rasmli e'lon kerakmi?", "Tayyor xabar yoki albomni botga yo'naltiring: 10 tagacha rasm. Yuklanishini kutib, «Tayyor»ni bosing. Xabarlarni o'chirmang."),
    ('select', 7, "E'lon guruhlarini tanlang", "Ulangan guruhlardan shu e'lon uchun keraklilarini belgilang. Limit tarifingizga bog'liq. So'ng «Tayyor»ni bosing."),
    ('interval', 6, "Takrorlash oralig'i", "Yuborish oralig'ini tanlang. Misolda — 20 daqiqa. Guruh qoidalariga mos oraliqni belgilang."),
    ('hours', 9, "Yuborish soatlari", "Boshlanish va tugash vaqtini tanlang. Misolda: har kuni 07:00–22:00. Barcha vaqtlar Toshkent bo'yicha."),
    ('first', 8, "Birinchi yuborish", "«Hozir yuborish» ham tanlangan soatlarga amal qiladi. «Jadval bo'yicha boshlash» — tanlangan oraliqdan keyin."),
    ('template', 6, "Shablon qilib saqlang", "Keyin yana ishlatish uchun «Ha»ni bosing. Matn, rasmlar, guruhlar va jadval shablonda saqlanadi."),
    ('confirm', 8, "Tekshiring va boshlang", "Matn, guruhlar va vaqtni tekshiring. Hammasi to'g'ri bo'lsa, «Ishga tushirish»ni bosing."),
    ('result', 7, "Natijani kuzating", "Natijani e'lon kartasida ko'ring. Yuborish ketma-ket bajariladi; Telegram cheklovlari sabab kutish mumkin."),
    ('pause', 8, "Yuborishni boshqaring", "Vaqtincha to'xtatish uchun «To'xtatib turish»ni bosing. «Davom ettirish» bilan yana ishga tushiring."),
    ('end', 7, "Tayyor. Vaqtingiz o'zingizga.", "Yordam uchun «Qo'llanma» yoki /help ni oching. Oldingi bosqichga botdagi «Orqaga» tugmasi bilan qayting."),
]
DURATION = sum(s[1] for s in SCENES)
LAYOUT_ISSUES = []

def wrap(draw, text, size, width, bold=False):
    f = font(size, bold)
    lines = []
    for paragraph in text.split('\n'):
        current = ''
        for word in paragraph.split(' '):
            candidate = f'{current} {word}'.strip()
            if current and draw.textlength(candidate, font=f) > width:
                lines.append(current)
                current = word
            else:
                current = candidate
        lines.append(current)
    return lines

def text(draw, value, x, y, size=26, width=540, fill=INK, bold=False, gap=1.34, max_bottom=None):
    lines = wrap(draw, value, size, width, bold)
    for n, line in enumerate(lines):
        draw.text((x, y + n * size * gap), line, font=font(size, bold), fill=fill)
    end = y + len(lines) * size * gap
    if max_bottom is not None and end > max_bottom:
        LAYOUT_ISSUES.append({'text':value, 'bottom':end, 'allowed':max_bottom})
    return end

def centered(draw, value, rect, size=25, fill=INK, bold=True):
    x1,y1,x2,y2 = rect
    while draw.textlength(value, font=font(size,bold)) > x2-x1-24:
        size -= 1
    box = draw.textbbox((0,0),value,font=font(size,bold))
    draw.text(((x1+x2)/2-draw.textlength(value,font=font(size,bold))/2,(y1+y2)/2-(box[3]-box[1])/2-box[1]),value,font=font(size,bold),fill=fill)

def rr(draw, rect, color=WHITE, radius=18, outline=None, width=1):
    draw.rounded_rectangle(rect, radius=radius, fill=color, outline=outline, width=width)

def button(draw, value, y, x=90, width=540, color='#DDEBDD', fill=INK, h=53):
    rect=(x,y,x+width,y+h)
    rr(draw,rect,color,12)
    centered(draw,value,rect,24,fill)
    return rect

def bubble(draw, value, y, outgoing=False, size=25, width=510):
    x=112 if outgoing else 86
    lines=wrap(draw,value,size,width-38)
    height=len(lines)*size*1.34+35
    rr(draw,(x,y,x+width,y+height),'#DDEECB' if outgoing else WHITE,17)
    text(draw,value,x+19,y+13,size,width-38,max_bottom=950)
    return y+height+14

def phone(draw, subtitle='bot', mini=False):
    rr(draw,(53,234,667,1005),'#DCE4D8',36)
    rr(draw,(59,228,661,997),WHITE,32,INK,2)
    draw.line((79,324,641,324),fill=LINE,width=2)
    draw.line([(85,271),(73,281),(85,291)],fill=INK,width=3)
    draw.ellipse((105,250,165,310),fill=GREEN)
    draw.polygon([(121,279),(151,268),(140,294),(132,282)],fill=WHITE)
    text(draw,'Elonbot' if not mini else "Guruh qo'shish",184,247,27,400,bold=True)
    text(draw,subtitle,184,285,18,400,fill=MUTED)
    draw.rectangle((61,326,659,945),fill=CHAT)
    rr(draw,(76,954,644,981),'#F2F4F0',13)
    text(draw,"Xabar…",92,955,18,300,fill=MUTED)

def mini_photo(draw, rect, number):
    x1,y1,x2,y2=rect
    rr(draw,rect,'#DAE4CE',12)
    draw.ellipse((x2-48,y1+19,x2-29,y1+38),fill='#9BB66D')
    draw.polygon([(x1+15,y2-38),(x1+59,y1+38),(x1+99,y2-38)],fill='#8CA489')
    draw.polygon([(x1+75,y2-38),(x1+121,y1+59),(x2-16,y2-38)],fill='#647F68')
    text(draw,f'Rasm {number}',x1+15,y2-31,18,130,fill=INK)

def base(index):
    kind,duration,title,caption=SCENES[index]
    image=Image.new('RGB',(W,H),PAPER)
    draw=ImageDraw.Draw(image)
    draw.ellipse((43,40,85,82),fill=GREEN)
    draw.polygon([(54,60),(74,52),(67,73),(63,64)],fill=WHITE)
    text(draw,'elonbot',96,37,31,260,bold=True)
    rr(draw,(493,43,674,79),'#E8EEDC',18)
    centered(draw,"O'ZBEKCHA",(493,43,674,79),17)
    text(draw,title,44,112,38,632,bold=True,max_bottom=220)
    hotspots=[]
    if kind not in ['intro','end']:
        phone(draw,'Ulangan akkaunt' if kind=='ready' else 'bot',mini=kind=='groups_app')
    if kind=='intro':
        text(draw,"E'lon → guruhlar → jadval",51,239,29,620,fill=MUTED)
        for n,(head,detail) in enumerate([
            ("01  E'loningiz","Matn yoki 10 tagacha rasm"),
            ('02  Guruhlaringiz',"Qayerga yuborishni o'zingiz tanlaysiz"),
            ('03  Vaqtingiz',"Bot belgilangan jadvalga amal qiladi")]):
            y=343+n*180
            rr(draw,(45,y,675,y+148),WHITE,24,LINE)
            text(draw,head,76,y+22,32,565,bold=True)
            text(draw,detail,76,y+81,23,565,fill=MUTED)
        text(draw,"Bosqichma-bosqich o'quv namoyishi",49,934,23,625,fill=MUTED)
    elif kind=='language':
        bubble(draw,'/start',348,True)
        y=bubble(draw,"Bot hozir o'zbek tilida. O'zbekcha davom eting yoki rus tilini tanlang:",437)
        hotspots=[(1.5,button(draw,"O'zbekcha davom etish",y))]
        button(draw,'Русский',y+63)
        text(draw,"Tilni keyin ham o'zgartirish mumkin.",91,833,23,527,fill=MUTED)
    elif kind=='ready':
        rr(draw,(91,392,629,706),WHITE,22)
        draw.ellipse((291,425,429,563),fill='#E6F2D8')
        draw.line([(329,493),(352,516),(395,466)],fill=GREEN,width=8)
        centered(draw,'Akkaunt ulangan',(104,594,616,645),28)
        text(draw,"Bu misolda ulanish tayyor.\nVideoda kirish jarayoni ko'rsatilmaydi.",102,754,25,510,fill=MUTED)
    elif kind=='groups_menu':
        y=bubble(draw,'Kerakli bo\'limni tanlang.',357)
        button(draw,label('menu','announcements'),y)
        r1=button(draw,label('menu','groups'),y+64)
        button(draw,label('menu','settings'),y+128)
        y2=bubble(draw,'Guruhlarni boshqarish',680)
        r2=button(draw,UZ['app']['open'],y2)
        hotspots=[(1.3,r1),(3.8,r2)]
    elif kind=='groups_app':
        rr(draw,(88,349,632,408),WHITE,12)
        text(draw,"Guruhni qidirish…",108,362,23,500,fill=MUTED)
        for n,name in enumerate(['Toshkent uylar','Yunusobod e\'lonlar','Ijara va savdo']):
            y=437+n*117
            rr(draw,(87,y,633,y+102),WHITE,16)
            text(draw,name,105,y+14,23,347,bold=True)
            text(draw,'Namuna guruh',105,y+58,18,300,fill=MUTED)
            r=button(draw,'Ulash',y+25,x=475,width=140,h=49)
            if n==0: hotspots.append((1.8,r))
        r=button(draw,'Botga qaytish',827,color=GREEN,fill=WHITE)
        hotspots.append((6.0,r))
    elif kind=='create':
        text(draw,label('menu','announcements'),93,353,27,515,bold=True)
        y=bubble(draw,UZ['announcements']['empty'],423)
        r=button(draw,label('announcements','create'),y)
        button(draw,label('announcements','from_template'),y+64)
        button(draw,label('common','back'),y+128)
        hotspots=[(1.7,r)]
    elif kind=='text':
        bubble(draw,UZ['announcements']['send_text'],349)
        bubble(draw,"2 xonali kvartira ijaraga.\nToshkent, Yunusobod.\nAloqa: [sizning kontaktingiz]",446,True)
        r=button(draw,label('common','continue'),730)
        button(draw,label('common','back'),794)
        text(draw,"Misol matn. O'z e'loningizni yozing.",93,877,20,530,fill=MUTED)
        hotspots=[(3.3,r)]
    elif kind=='photos':
        text(draw,"Tayyor albomni yo'naltiring",89,348,25,540,bold=True)
        rr(draw,(105,402,630,714),'#DDEECB',18)
        text(draw,"Yo'naltirilgan xabar · namuna",126,415,18,483,fill=GREEN)
        mini_photo(draw,(126,456,358,605),1)
        mini_photo(draw,(373,456,610,605),2)
        text(draw,"2 xonali kvartira ijaraga…",126,631,25,464)
        r=button(draw,label('common','done'),741)
        rr(draw,(89,817,631,917),'#FFF1CB',14)
        text(draw,"Muhim: rasmli xabarlarni bot chatidan o'chirmang.",107,835,23,505,fill='#685017')
        hotspots=[(4.8,r)]
    elif kind=='select':
        bubble(draw,"E'lon yuboriladigan guruhlarni tanlang.\nTanlangan: 2 / 30",346)
        for n,name in enumerate(['Toshkent uylar','Yunusobod e\'lonlar','Ijara va savdo']):
            y=514+n*66
            r=button(draw,name,y)
            if n<2:
                draw.ellipse((107,y+17,126,y+36),fill=GREEN)
                draw.line([(111,y+25),(116,y+31),(122,y+22)],fill=WHITE,width=2)
        r=button(draw,label('common','done'),734,color=GREEN,fill=WHITE)
        text(draw,"30 — misoldagi limit.\nJoriy limit «Tarif»da ko'rsatiladi.",93,824,23,520,fill=MUTED)
        hotspots=[(3.3,r)]
    elif kind=='interval':
        bubble(draw,UZ['announcements']['select_interval'],347)
        for n,minute in enumerate([5,10,15,20,60,120]):
            r=button(draw,UZ['language']['minutes'].replace('{count}',str(minute)),465+n*63)
            if minute==20: hotspots=[(2.4,r)]
        text(draw,'Boshqa oraliqlar ham mavjud.',94,884,22,523,fill=MUTED)
    elif kind=='hours':
        text(draw,"Toshkent vaqti · UTC+5",91,348,24,529,fill=GREEN,bold=True)
        text(draw,"Boshlanishi",92,407,24,527,bold=True)
        r1=button(draw,'07:00',457,color=GREEN,fill=WHITE)
        text(draw,"Tugashi",92,554,24,527,bold=True)
        r2=button(draw,'22:00',604,color=GREEN,fill=WHITE)
        rr(draw,(90,724,630,872),WHITE,17)
        text(draw,'Har kuni 07:00–22:00',111,747,27,498,bold=True)
        text(draw,"Tanlangan soatlardan tashqarida bot kutadi.",111,802,23,490,fill=MUTED)
        hotspots=[(1.6,r1),(4.8,r2)]
    elif kind=='first':
        bubble(draw,UZ['announcements']['select_first_run'],345,size=23)
        r=button(draw,label('announcements','immediate'),552)
        button(draw,label('announcements','scheduled'),618)
        rr(draw,(91,735,629,887),WHITE,18)
        text(draw,"«Hozir» — ruxsat etilgan soatlarda, imkon bo'lishi bilan.",110,757,25,497,fill=MUTED)
        hotspots=[(2.5,r)]
    elif kind=='template':
        y=bubble(draw,UZ['announcements']['save_template'],355,size=24)
        r=button(draw,UZ['common']['yes'],y)
        button(draw,UZ['common']['no'],y+66)
        text(draw,"Keyingi safar «Shablonlar»dan foydalaning.",95,802,25,520,fill=MUTED)
        hotspots=[(2.0,r)]
    elif kind=='confirm':
        y=bubble(draw,"E'lonni tekshiring:\n\n2 xonali kvartira ijaraga.\nToshkent, Yunusobod.\n\nGuruhlar: 2 ta\nOraliq: 20 daqiqa\nVaqt: 07:00–22:00\nRasmlar: 2 ta",344,size=23)
        r=button(draw,label('announcements','start'),y,color=GREEN,fill=WHITE)
        button(draw,label('common','cancel'),y+64)
        hotspots=[(3.6,r)]
    elif kind=='result':
        bubble(draw,UZ['announcements']['created'],348)
        rr(draw,(88,479,632,735),WHITE,18)
        text(draw,'E\'lon holati: Faol',109,498,27,499,bold=True)
        for n,(title,value) in enumerate([('Yuborildi','2'),('Navbatda','0'),('Xatolar','0')]):
            y=561+n*52
            text(draw,title,113,y,23,340,fill=MUTED)
            text(draw,value,552,y,26,60,bold=True)
        r=button(draw,label('announcements','refresh_status'),770)
        text(draw,"Natijalar o'quv misoli uchun.",94,862,21,520,fill=MUTED)
        hotspots=[(3.2,r)]
    elif kind=='pause':
        bubble(draw,"E'lonlarim → e'lon kartasi",348)
        r1=button(draw,label('announcements','pause'),469,color=GREEN,fill=WHITE)
        bubble(draw,"To'xtatilgan",570)
        r2=button(draw,label('announcements','resume_sending'),678)
        text(draw,"E'lon va avvalgi xabarlar saqlanadi.",94,812,25,520,fill=MUTED)
        hotspots=[(1.7,r1),(5.0,r2)]
    elif kind=='end':
        rr(draw,(43,289,677,790),GREEN,28)
        text(draw,"1. E'lon tayyorlang\n2. Guruhlarni tanlang\n3. Jadvalni belgilang",79,332,34,567,WHITE,True,gap=1.8)
        draw.line((80,586,638,586),fill='#698B6D',width=2)
        text(draw,'@elonyuborishbot',78,632,37,563,WHITE,True)
        text(draw,'t.me/elonyuborishbot',80,697,25,564,'#D5EF83')
        rr(draw,(44,832,676,955),WHITE,20,LINE)
        text(draw,"Yordam: «Qo'llanma» yoki /help",73,855,28,570,bold=True)
        text(draw,"Orqaga: botdagi tugma yoki /back",74,901,23,571,fill=MUTED)
    draw.line((45,1026,675,1026),fill=LINE,width=2)
    text(draw,caption,45,1053,27,630,max_bottom=1220)
    text(draw,"O'quv namoyishi · shartli ma'lumotlar",44,1235,17,575,fill=MUTED)
    text(draw,f'{index+1:02d}/{len(SCENES)}',611,1235,17,90,fill=MUTED)
    return image,hotspots

def frame_at(index, local_time, global_time, cached):
    image,hotspots=cached[index]
    result=image.copy()
    draw=ImageDraw.Draw(result)
    for at,rect in hotspots:
        elapsed=local_time-at
        if 0 <= elapsed <= 1.6:
            x1,y1,x2,y2=rect
            strength=math.sin(math.pi*min(elapsed/1.6,1))
            draw.rounded_rectangle((x1-5,y1-5,x2+5,y2+5),radius=17,outline='#78A63D',width=4)
            cx,cy=x2-29,(y1+y2)/2
            radius=10+int(strength*16)
            draw.ellipse((cx-radius,cy-radius,cx+radius,cy+radius),outline='#446D2C',width=3)
            draw.ellipse((cx-6,cy-6,cx+6,cy+6),fill=LIME)
    draw.rectangle((0,1273,W,1279),fill=LINE)
    draw.rectangle((0,1273,max(1,int(W*global_time/DURATION)),1279),fill=GREEN)
    # A short fade preserves reading time and avoids distracting camera motion.
    if local_time < .24 and index > 0:
        previous=cached[index-1][0]
        result=Image.blend(previous,result,local_time/.24)
    return result

def timestamp(t):
    ms=round(t*1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--ffmpeg')
    parser.add_argument('--preview-only',action='store_true')
    args=parser.parse_args()
    cached=[base(i) for i in range(len(SCENES))]
    assert not LAYOUT_ISSUES, json.dumps(LAYOUT_ISSUES,ensure_ascii=False,indent=2)
    previews=ROOT/'frames'
    previews.mkdir(exist_ok=True)
    time=0
    manifest=[]
    subtitles=[]
    for i,(kind,seconds,title,caption) in enumerate(SCENES):
        sample=frame_at(i,min(seconds-1,3),time+3,cached)
        sample.save(previews/f'{i+1:02}-{kind}.png')
        manifest.append({'scene':i+1,'kind':kind,'title':title,'start':time,'duration':seconds,'caption':caption})
        subtitles.append(f'{i+1}\n{timestamp(time)} --> {timestamp(time+seconds)}\n{caption}\n')
        time+=seconds
    cached[0][0].save(ROOT/'cover.png')
    contact=Image.new('RGB',(240*6,427*3),PAPER)
    for i,(image,_) in enumerate(cached):
        contact.paste(image.resize((240,427),Image.Resampling.LANCZOS),((i%6)*240,(i//6)*427))
    contact.save(ROOT/'storyboard.jpg',quality=92)
    (ROOT/'subtitles-uz.srt').write_text('\n'.join(subtitles),encoding='utf-8')
    (ROOT/'scenes.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    if args.preview_only:
        print(f'Preview ready: {len(SCENES)} scenes, {DURATION}s, no layout overflow.',flush=True)
        return
    assert args.ffmpeg, '--ffmpeg is required for video output'
    output=ROOT/'elonbot-qollanma-uz.mp4'
    command=[args.ffmpeg,'-hide_banner','-loglevel','warning','-y','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart','-metadata','title=Elonbot — foydalanish qollanmasi','-metadata','comment=Illustrated tutorial; synthetic demo data; Uzbek captions',str(output)]
    encoder=subprocess.Popen(command,stdin=subprocess.PIPE,stderr=open(ROOT/'encode.log','w',encoding='utf-8'))
    total=0
    for i,scene in enumerate(SCENES):
        for n in range(scene[1]*FPS):
            encoder.stdin.write(frame_at(i,n/FPS,total/FPS,cached).tobytes())
            total+=1
        print(f'Encoded scene {i+1}/{len(SCENES)}: {scene[0]}',flush=True)
    encoder.stdin.close()
    assert encoder.wait()==0, (ROOT/'encode.log').read_text(encoding='utf-8')
    result={'file':output.name,'width':W,'height':H,'fps':FPS,'seconds':DURATION,'frames':total,'audio':False,'language':'uz','bytes':output.stat().st_size,'scene_count':len(SCENES),'layout_overflow':False}
    (ROOT/'verification.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result),flush=True)

if __name__=='__main__':
    main()
