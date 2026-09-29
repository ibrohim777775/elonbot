"""Telegram-style, offline instructional recording; never talks to Telegram.
Keeps v1 intact. Actual Mini App captures + recreated chat on synthetic data.
Motion purpose: explanation. 200ms ease-out state transitions, 160ms taps.
"""
from pathlib import Path
from functools import lru_cache
import argparse, html, json, math, subprocess
from PIL import Image, ImageDraw, ImageFont
from render import SCENES as ORIGINAL_SCENES, timestamp

ROOT=Path(__file__).resolve().parent/'telegram'
APP=ROOT.parent.parent.parent
UZ=json.loads((APP/'app/uz.json').read_text(encoding='utf-8'))
W,H,FPS,UI=720,1280,24,1050
BG,HEADER,INCOMING,OUTGOING,KEY='#0E1621','#17212B','#182533','#2B5278','#253746'
TEXT,MUTED,BLUE,LINE='#F0F3F5','#9AAEBE','#64B5EF','#263848'
CAPTION='#08111A'
CHECKS=[]

@lru_cache(maxsize=64)
def font(size=28,bold=False):
    return ImageFont.truetype('C:/Windows/Fonts/'+('arialbd.ttf' if bold else 'arial.ttf'),size)

def label(group,key):
    return UZ[group][key].replace('⏸ ','').replace('▶️ ','').replace('🔄 ','').replace('📖 ','').replace('⚙️ ','').replace('✉️ ','')

def lines(text,size,width,bold=False):
    out=[]
    for para in text.split('\n'):
        row=''
        for word in para.split(' '):
            candidate=(row+' '+word).strip()
            if row and font(size,bold).getlength(candidate)>width:
                out.append(row);row=word
            else:row=candidate
        out.append(row)
    return out

def write(d,value,x,y,size=28,width=640,color=TEXT,bold=False,limit=None):
    split=lines(value,size,width,bold)
    for n,line in enumerate(split):d.text((x,y+n*size*1.28),line,font=font(size,bold),fill=color)
    bottom=y+len(split)*size*1.28
    if limit and bottom>limit:CHECKS.append({'value':value,'bottom':bottom,'limit':limit})
    return bottom

def center(d,value,r,size=27,color=TEXT,bold=False):
    x1,y1,x2,y2=r
    while font(size,bold).getlength(value)>x2-x1-22:size-=1
    b=d.textbbox((0,0),value,font=font(size,bold))
    d.text(((x1+x2-font(size,bold).getlength(value))/2,(y1+y2-b[3]+b[1])/2-b[1]),value,font=font(size,bold),fill=color)

def rr(d,r,fill=INCOMING,radius=13,outline=None,width=1):
    d.rounded_rectangle(r,radius=radius,fill=fill,outline=outline,width=width)

def icon(d,kind,cx,cy,size=24,color=TEXT):
    if kind=='back':d.line([(cx+8,cy-14),(cx-7,cy),(cx+8,cy+14)],fill=color,width=3)
    elif kind=='down':d.line([(cx-12,cy-6),(cx,cy+6),(cx+12,cy-6)],fill=color,width=3)
    elif kind=='check':d.line([(cx-10,cy),(cx-3,cy+7),(cx+12,cy-10)],fill=color,width=3)
    elif kind=='double':
        icon(d,'check',cx-5,cy,18,color);d.line([(cx+3,cy+7),(cx+18,cy-10)],fill=color,width=3)
    elif kind=='send':
        d.polygon([(cx-14,cy-12),(cx+17,cy),(cx-14,cy+12),(cx-7,cy)],fill=color)
    elif kind=='dots':
        for dy in [-10,0,10]:d.ellipse((cx-3,cy+dy-3,cx+3,cy+dy+3),fill=color)
    elif kind=='smile':
        d.ellipse((cx-17,cy-17,cx+17,cy+17),outline=color,width=2)
        for dx in [-6,6]:d.ellipse((cx+dx-2,cy-6,cx+dx+2,cy-2),fill=color)
        d.arc((cx-10,cy-8,cx+10,cy+10),20,160,fill=color,width=2)
    elif kind=='paperclip':
        d.arc((cx-12,cy-16,cx+12,cy+17),-80,255,fill=color,width=3)
        d.line((cx-7,cy-13,cx-7,cy+11),fill=color,width=3)
        d.arc((cx-7,cy-8,cx+6,cy+11),0,180,fill=color,width=2)
    elif kind=='mic':
        rr(d,(cx-6,cy-17,cx+6,cy+6),color,6)
        d.arc((cx-13,cy-10,cx+13,cy+13),0,180,fill=color,width=3)
        d.line((cx,cy+13,cx,cy+20),fill=color,width=3)
    elif kind=='keyboard':
        rr(d,(cx-17,cy-11,cx+17,cy+11),None,3,color,2)
        for row in range(2):
            for col in range(4):d.rectangle((cx-12+col*7,cy-6+row*7,cx-9+col*7,cy-3+row*7),fill=color)
    elif kind=='forward':
        d.polygon([(cx-12,cy+10),(cx-10,cy-7),(cx+2,cy-7),(cx+2,cy-17),(cx+18,cy-2),(cx+2,cy+13),(cx+2,cy+3)],fill=color)
    elif kind=='search':
        d.ellipse((cx-13,cy-13,cx+9,cy+9),outline=color,width=3)
        d.line((cx+7,cy+7,cx+18,cy+18),fill=color,width=3)

def wallpaper():
    im=Image.new('RGB',(W,UI),BG);d=ImageDraw.Draw(im)
    # Quiet geometric chat wallpaper. No downloaded Telegram graphic is reused.
    for y in range(175,UI,106):
        for x in range(-10,W,123):
            z=x+(49 if (y//106)%2 else 0)
            d.line([(z,y+27),(z+27,y+15),(z+18,y+42),(z+13,y+29),(z,y+27)],fill='#152330',width=2)
            d.arc((z+55,y+50,z+75,y+70),0,320,fill='#162430',width=2)
    return im

WALL=wallpaper()

def shell(title='Elonbot',subtitle='bot',mode='chat'):
    im=WALL.copy();d=ImageDraw.Draw(im)
    d.rectangle((0,0,W,145),fill=HEADER)
    write(d,'9:41',25,14,22,bold=True)
    for n in range(4):d.rectangle((591+n*7,31-n*4,595+n*7,34),fill=TEXT)
    d.arc((626,10,657,34),212,328,fill=TEXT,width=3)
    d.arc((632,16,651,34),212,328,fill=TEXT,width=3)
    rr(d,(674,17,705,32),None,3,TEXT,2);d.rectangle((678,21,698,28),fill=TEXT)
    if mode=='list':
        for yy in [78,88,98]:d.line((28,yy,58,yy),fill=TEXT,width=3)
        write(d,'Telegram',96,75,33,bold=True);icon(d,'search',674,92)
    else:
        icon(d,'back',39,92)
        if mode=='picker':write(d,title,90,75,32,bold=True);icon(d,'search',674,93)
        elif mode=='mini':
            write(d,'Elonbot',94,68,30,bold=True);write(d,'Mini App',94,106,21,color=MUTED);icon(d,'down',618,91);icon(d,'dots',680,91)
        else:
            d.ellipse((82,60,147,125),fill='#367E64' if title=='Elonbot' else '#518DBB')
            if title=='Elonbot':center(d,'E',(82,60,147,125),34,bold=True)
            else:icon(d,'send',115,93,24)
            write(d,title,167,64,31,bold=True,width=451);write(d,subtitle,167,105,21,color=MUTED,width=452);icon(d,'dots',679,91)
    return im,d

def date(d,y=164):
    rr(d,(299,y,421,y+39),'#23333E',19);center(d,'Bugun',(299,y,421,y+39),21)

def composer(d,menu=False,typed='',native=False):
    top=808 if menu else (720 if native else 957)
    d.rectangle((0,top,W,UI),fill=HEADER)
    d.line((0,top,W,top),fill=LINE,width=1)
    icon(d,'smile',36,top+40,color=MUTED)
    write(d,typed or 'Xabar',77,top+21,27,475,TEXT if typed else MUTED)
    if typed:
        d.ellipse((650,top+12,707,top+69),fill=BLUE);icon(d,'send',678,top+40,color=HEADER)
    else:
        icon(d,'keyboard',569,top+41,color=MUTED);icon(d,'paperclip',625,top+40,color=MUTED);icon(d,'mic',680,top+40,color=MUTED)
    rects={}
    if menu:
        rows=[[label('menu','announcements'),label('menu','templates')],[label('menu','groups'),label('menu','settings')],[label('menu','support'),label('menu','help')]]
        for row,labels in enumerate(rows):
            for col,value in enumerate(labels):
                x=10+col*355;y=887+row*47;r=(x,y,x+345,y+40)
                rr(d,r,'#273443',7);center(d,value,r,23);rects[value]=r
    if native:
        d.rectangle((0,798,W,UI),fill='#222D38')
        for row,chars in enumerate(['qwertyuiop','asdfghjkl','zxcvbnm']):
            size=58;offset=(W-len(chars)*68)/2
            for col,char in enumerate(chars):
                r=(offset+col*68,815+row*51,offset+col*68+size,859+row*51)
                rr(d,r,'#364451',5);center(d,char,r,24)
        rr(d,(149,981,569,1027),'#364451',6);center(d,"O'zbekcha",(149,981,569,1027),21,color=MUTED)
    d.line((288,1038,432,1038),fill='#CDD8DF',width=4)
    return rects

def message(d,value,y,out=False,width=612,size=28,stamp='09:41',forward=None):
    x=W-width-17 if out else 17
    extra=55 if forward else 0
    rows=lines(value,size,width-36)
    height=len(rows)*size*1.28+49+extra
    r=(x,y,x+width,y+height)
    rr(d,r,OUTGOING if out else INCOMING,16)
    d.polygon([(x+width-14,y+height-16),(x+width+8,y+height),(x+width-26,y+height)] if out else [(x+14,y+height-16),(x-8,y+height),(x+26,y+height)],fill=OUTGOING if out else INCOMING)
    if forward:
        d.line((x+18,y+15,x+18,y+58),fill=BLUE,width=3);write(d,'Yo\'naltirilgan xabar',x+29,y+14,21,width-52,BLUE,bold=True)
    write(d,value,x+18,y+13+extra,size,width-36,limit=941)
    write(d,stamp,x+width-104,y+height-29,18,72,MUTED)
    if out:icon(d,'double',x+width-31,y+height-17,color='#93C4E9')
    return y+height+7

def inline(d,rows,y,x=17,width=612,h=56):
    rects={}
    for row in rows:
        cw=(width-6*(len(row)-1))/len(row)
        for col,item in enumerate(row):
            value,checked=(item if isinstance(item,tuple) else (item,False))
            r=(x+col*(cw+6),y,x+col*(cw+6)+cw,y+h)
            rr(d,r,KEY,7);center(d,value,r,25)
            if checked:
                d.ellipse((r[0]+16,y+19,r[0]+35,y+38),fill='#61B36A');icon(d,'check',r[0]+26,y+28,size=12,color=TEXT)
            rects[value]=r
        y+=h+6
    return y,rects

PHOTO=Image.open(ROOT/'assets/apartment-demo.png').convert('RGB')
MINI={k:Image.open(ROOT/f'assets/groups-{k}.png').convert('RGB').resize((720,900),Image.Resampling.LANCZOS) for k in ['top','search','connected']}

def album(im,d,y=268,out=True,forward=False):
    x=107 if out else 17;wid=594;ph=297
    rr(d,(x,y,x+wid,y+ph+152+(48 if forward else 0)),OUTGOING if out else INCOMING,16)
    top=y+9
    if forward:
        write(d,"Yo'naltirilgan xabar",x+18,y+12,21,540,BLUE,bold=True);top+=45
    im.paste(PHOTO.resize((wid-14,ph),Image.Resampling.LANCZOS),(x+7,int(top)))
    write(d,"2 xonali kvartira ijaraga.\nToshkent, Yunusobod.\nAloqa: [sizning kontaktingiz]",x+16,top+ph+12,25,wid-30)
    write(d,'09:41',x+wid-100,top+ph+116,18,66,MUTED)
    if out:icon(d,'double',x+wid-30,top+ph+128,color='#93C4E9')
    return top+ph+155

def state(index,phase=0):
    kind=ORIGINAL_SCENES[index][0]
    im,d=shell()
    taps=[]
    if kind=='intro':
        im,d=shell(mode='list')
        d.rectangle((0,146,W,UI),fill=BG)
        for n,(name,small,color) in enumerate([('Elonbot',"E'lonlar uchun yordamchi bot",'#367E64'),('Saqlangan xabarlar',"Kvartira uchun tayyor e'lon",'#518DBB')]):
            y=163+n*120;d.ellipse((25,y+7,110,y+92),fill=color)
            if n==0:center(d,'E',(25,y+7,110,y+92),40,bold=True)
            else:icon(d,'send',67,y+49)
            write(d,name,135,y+15,31,500,bold=True);write(d,small,135,y+60,24,530,MUTED)
            d.line((135,y+113,720,y+113),fill=LINE,width=1)
        taps=[(168,208)]
    elif kind=='language':
        date(d);message(d,'/start',228,True,170)
        y=message(d,UZ['start']['welcome']+'\n\n'+UZ['language']['first_choice'],325,size=27)
        y,r=inline(d,[["O'zbekcha davom etish"],['Русский']],y)
        composer(d);taps=[mid(r["O'zbekcha davom etish"])]
    elif kind=='ready':
        date(d)
        message(d,UZ['start']['welcome'],225)
        message(d,UZ['start']['choose_section'],564)
        composer(d,menu=True)
    elif kind=='groups_menu':
        date(d);message(d,UZ['start']['choose_section'],228)
        r=composer(d,menu=True)
        if phase==0:taps=[mid(r[label('menu','groups')])]
        else:
            message(d,label('menu','groups'),351,True,179)
            y=message(d,'Ulangan guruhlar:',447)
            _,r=inline(d,[["Toshkent · E'lonlar"],['Biznes hamkorlar'],[UZ['app']['open']],['Orqaga']],y,h=49)
            taps=[mid(r[UZ['app']['open']])]
    elif kind=='groups_app':
        im,d=shell(mode='mini')
        name=['top','search','connected'][phase]
        im.paste(MINI[name],(0,147));d=ImageDraw.Draw(im)
        taps=[(578,593)] if phase==1 else ([(510,939)] if phase==2 else [])
    elif kind=='create':
        date(d);message(d,label('menu','announcements'),224,True,219)
        y=message(d,UZ['announcements']['empty'],332)
        _,r=inline(d,[[label('announcements','create')],['Orqaga']],y)
        composer(d,menu=True);taps=[mid(r[label('announcements','create')])]
    elif kind=='text':
        message(d,UZ['announcements']['create_instruction'],165,size=25)
        if phase==0:
            composer(d,native=True,typed="2 xonali kvartira ijaraga…")
            taps=[(679,760)]
        else:
            y=message(d,"2 xonali kvartira ijaraga.\nToshkent, Yunusobod.\nAloqa: [sizning kontaktingiz]",590,True,588,size=26)
            _,r=inline(d,[[label('common','continue')],['Orqaga']],y,x=17,h=50)
            composer(d)
    elif kind=='photos':
        if phase==0:
            im,d=shell('Saqlangan xabarlar','shaxsiy eslatmalar')
            date(d);album(im,d,262)
            d.ellipse((23,611,81,669),fill=KEY);icon(d,'forward',52,640)
            composer(d);taps=[(51,640)]
        elif phase==1:
            im,d=shell('Yuborish…',mode='picker');d.rectangle((0,146,W,UI),fill=BG)
            for n,(name,sub) in enumerate([('Elonbot','@elonyuborishbot'),('Saqlangan xabarlar',"Xabarni o'zingizga yuborish")]):
                y=164+n*117;d.ellipse((22,y+9,101,y+88),fill='#367E64' if n==0 else '#518DBB');center(d,'E' if n==0 else 'S',(22,y+9,101,y+88),36,bold=True)
                write(d,name,124,y+15,30,540,bold=True);write(d,sub,124,y+58,24,540,MUTED)
            taps=[(252,210)]
        else:
            bottom=album(im,d,174,True,True)
            y=message(d,UZ['announcements']['photos_continue'],bottom,size=23)
            _,r=inline(d,[[label('common','done')],['Orqaga']],y,h=47)
            composer(d);taps=[mid(r[label('common','done')])]
    elif kind=='select':
        date(d);y=message(d,UZ['announcements']['select_groups'].replace('{limit}','30').replace('{count}',str(phase)),225)
        rows=[[("Toshkent · E'lonlar",phase>=1)],[('Biznes hamkorlar',False)],[('Uy-joy va ijara',phase>=2)],['Tayyor'],['Orqaga']]
        _,r=inline(d,rows,y)
        composer(d);taps=[mid(r["Toshkent · E'lonlar"] if phase==0 else r['Uy-joy va ijara'] if phase==1 else r['Tayyor'])]
    elif kind=='interval':
        y=message(d,UZ['announcements']['select_interval'],169)
        _,r=inline(d,[[f'{n} daqiqa'] for n in [5,10,15,20,60,120,180,300,480]]+[['Orqaga']],y,h=54)
        composer(d);taps=[mid(r['20 daqiqa'])]
    elif kind=='hours':
        prompt=UZ['announcements']['window_start'] if phase==0 else UZ['announcements']['window_end'].replace('{start}','07:00')
        y=message(d,prompt,163,size=26)
        hours=range(0,24) if phase==0 else range(1,25)
        values=[f'{n:02}:00' for n in hours]
        rows=[values[n:n+4] for n in range(0,24,4)]
        _,r=inline(d,rows+[[label('announcements','window_custom')],[label('announcements','window_all')],['Orqaga']],y,h=54)
        composer(d);taps=[mid(r['07:00' if phase==0 else '22:00'])]
    elif kind=='first':
        date(d);y=message(d,UZ['announcements']['select_first_run'],235)
        _,r=inline(d,[[label('announcements','immediate'),label('announcements','scheduled')],['Orqaga']],y)
        composer(d);taps=[mid(r[label('announcements','immediate')])]
    elif kind=='template':
        date(d);y=message(d,UZ['announcements']['save_template'],235)
        _,r=inline(d,[['Ha',"Yo'q"],['Orqaga']],y)
        composer(d);taps=[mid(r['Ha'])]
    elif kind=='confirm':
        y=message(d,"E'lonni tekshiring:\n\n2 xonali kvartira ijaraga.\nToshkent, Yunusobod.\nAloqa: [sizning kontaktingiz]\n\nOraliq: 20 daqiqa\nGuruhlar: Toshkent · E'lonlar, Uy-joy va ijara\nYuborish vaqti: Har kuni 07:00–22:00 (Toshkent, UTC+5)\nBirinchi yuborish: Hozir yuborish\nRasmlar: 2\n\nRasmli xabarlarni chatda qoldiring.",167,size=25)
        _,r=inline(d,[[label('announcements','start'),'Bekor qilish'],['Orqaga']],y,h=51)
        composer(d);taps=[mid(r[label('announcements','start')])]
    elif kind=='result':
        date(d);message(d,UZ['announcements']['created'],225)
        if phase>=1:
            y=message(d,"Oxirgi yuborish natijasi:\nGuruhlar: 2\nYuborildi: 2\nNavbatda: 0\nXatolar: 0\n\nVaqt — Toshkent.",383)
            _,r=inline(d,[[label('announcements','refresh_status')]],y)
        composer(d,menu=True)
    elif kind=='pause':
        status="To'xtatilgan" if phase==1 else 'Faol'
        action=label('announcements','resume_sending') if phase==1 else label('announcements','pause')
        date(d)
        y=message(d,f"E'lon: 2 xonali kvartira ijaraga.\n\nHolat: {status}\nOraliq: 20 daqiqa\nGuruhlar: 2\nYuborish vaqti: 07:00–22:00\nToshkent, UTC+5",225)
        _,r=inline(d,[[action],[label('announcements','refresh_status')],['Tahrirlash',"O'chirish"],['Orqaga']],y)
        composer(d);taps=[mid(r[action])]
    elif kind=='end':
        date(d);message(d,'/help',225,True,156)
        y=message(d,UZ['help']['prompt'],331)
        _,r=inline(d,[[label('menu','help')]],y)
        composer(d,menu=True);taps=[mid(r[label('menu','help')])]
    return im,taps

def mid(r):return ((r[0]+r[2])/2,(r[1]+r[3])/2)

# Keyframes are actual explanatory states; gestures lead into their result.
PHASES={3:[0,3.2],4:[0,2.4,5.2],6:[0,3.2],7:[0,2.0,4.0],8:[0,1.8,3.6],10:[0,4.5],14:[0,2.4],15:[0,2.5,5.2]}
SCENES=list(ORIGINAL_SCENES)
SCENES[4]=('groups_app',9,"Guruhni ulang", "Qidiruvda guruhni toping. «Ulash»ni bosing. Guruhda e'lon berishga ruxsat bo'lishi kerak. So'ng botga qayting.")
SCENES[6]=('text',7,"E'lon matni", "E'lon matni va kontaktingizni yozing. Rasmsiz variantda «Davom etish»ni bosing.")
SCENES[7]=('photos',10,"Tayyor albomni yo'naltiring", "Tayyor albom → yo'naltirish → Elonbot. 10 tagacha rasm. Yuklanishini kutib, «Tayyor»ni bosing. Xabarlarni chatda qoldiring.")
SCENES[8]=('select',7,"E'lon uchun guruhlar", "Guruhlarni belgilang va «Tayyor»ni bosing. 30 — misoldagi limit; joriy limit tarifingizda ko'rsatiladi.")
SCENES[14]=('result',7,"Yuborish natijasi", "Natijani e'lon kartasida ko'ring. Bu yerda natijalar o'quv misoli. Telegram cheklovlari sabab yuborish kechikishi mumkin.")
TOTAL=sum(s[1] for s in SCENES)

def bezier(u,x1=.23,y1=1,x2=.32,y2=1):
    # Animate skill's strong ease-out cubic-bezier(.23,1,.32,1).
    low,high=0.,1.
    for _ in range(13):
        t=(low+high)/2;x=3*(1-t)**2*t*x1+3*(1-t)*t*t*x2+t**3
        if x<u:low=t
        else:high=t
    return 3*(1-t)**2*t*y1+3*(1-t)*t*t*y2+t**3

def overlay(index):
    im=Image.new('RGB',(W,H-UI),CAPTION);d=ImageDraw.Draw(im)
    write(d,f"O'QUV NAMOYISHI  ·  {index+1:02}/{len(SCENES)}",24,12,16,664,BLUE,bold=True)
    end=write(d,SCENES[index][2],24,39,28,670,bold=True)
    write(d,SCENES[index][3],24,end+7,23,672,limit=H-UI-12)
    return im

def frame(index,t,elapsed,cache,overlays,reduced=False):
    ats=PHASES.get(index,[0]);p=max(n for n,at in enumerate(ats) if t>=at)
    scene,taps=cache[(index,p)]
    canvas=scene.copy()
    since=t-ats[p]
    if p>0 and since<.20:
        # Opacity + small translation: stable direction, no scaling or camera zoom.
        before=cache[(index,p-1)][0]
        alpha=bezier(since/.20)
        shifted=canvas
        if not reduced and index!=4:
            shifted=WALL.copy();shifted.paste(canvas,(0,round(12*(1-alpha))))
            shifted.paste(canvas.crop((0,0,W,145)),(0,0))
        canvas=Image.blend(before,shifted,alpha)
    out=Image.new('RGB',(W,H),CAPTION);out.paste(canvas,(0,0));out.paste(overlays[index],(0,UI))
    d=ImageDraw.Draw(out)
    next_at=ats[p+1] if p+1<len(ats) else SCENES[index][1]-.9
    tap_at=max(ats[p]+.7,next_at-.65)
    if taps and 0<=t-tap_at<.65:
        u=(t-tap_at)/.65;cx,cy=taps[0]
        radius=20 if reduced else 17+round(15*bezier(u))
        layer=Image.new('RGBA',(W,H));ld=ImageDraw.Draw(layer)
        ld.ellipse((cx-radius,cy-radius,cx+radius,cy+radius),fill=(192,221,243,round(70*(1-u))),outline=(224,242,255,round(220*(1-u))),width=3)
        ld.ellipse((cx-8,cy-8,cx+8,cy+8),fill=(240,250,255,round(190*(1-u))))
        out=Image.alpha_composite(out.convert('RGBA'),layer).convert('RGB');d=ImageDraw.Draw(out)
    d.rectangle((0,H-4,W,H),fill=LINE)
    d.rectangle((0,H-4,int(W*elapsed/TOTAL),H),fill=BLUE)
    return out

def export_preview(cache,overlays):
    folder=ROOT/'frames';folder.mkdir(exist_ok=True)
    board=Image.new('RGB',(240*6,427*3),CAPTION)
    elapsed=0;manifest=[];srt=[];steps=[]
    for i,scene in enumerate(SCENES):
        sample_time=SCENES[i][1]-1.2
        picture=frame(i,sample_time,elapsed+sample_time,cache,overlays)
        picture.save(folder/f'{i+1:02}-{scene[0]}.png')
        board.paste(picture.resize((240,427),Image.Resampling.LANCZOS),((i%6)*240,(i//6)*427))
        for p,at in enumerate(PHASES.get(i,[0])):
            pic=frame(i,at+.5,elapsed+at+.5,cache,overlays)
            pic.save(folder/f'{i+1:02}-{scene[0]}-state{p}.png')
        pictures=''.join(f'<img src="frames/{i+1:02}-{scene[0]}-state{p}.png" width="720" height="1280" loading="lazy" alt="{html.escape(scene[2],quote=True)} — {p+1}">' for p in range(len(PHASES.get(i,[0]))))
        steps.append(f'<section><h2>{i+1:02}. {html.escape(scene[2])}</h2><p>{html.escape(scene[3])}</p><div class="states">{pictures}</div></section>')
        manifest.append({'scene':i+1,'kind':scene[0],'start':elapsed,'duration':scene[1],'title':scene[2],'caption':scene[3],'states':len(PHASES.get(i,[0]))})
        srt.append(f'{i+1}\n{timestamp(elapsed)} --> {timestamp(elapsed+scene[1])}\n{scene[3]}\n')
        elapsed+=scene[1]
    board.save(ROOT/'storyboard.jpg',quality=94)
    frame(7,6,51,cache,overlays).save(ROOT/'cover.png')
    (ROOT/'subtitles-uz.srt').write_text('\n'.join(srt),encoding='utf-8')
    (ROOT/'scenes.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    (ROOT/'steps.html').write_text('''<!doctype html><html lang="uz"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Elonbot — rasmlarda qo'llanma</title><style>*{box-sizing:border-box}body{margin:0;background:#0e1621;color:#eef3f8;font:17px/1.6 system-ui,sans-serif}main{max-width:1150px;margin:auto;padding:30px 20px}a{color:#8ac8ff}h1{line-height:1.2}section{padding:24px 0;border-top:1px solid #253746}.states{display:flex;flex-wrap:wrap;gap:16px}img{display:block;width:min(100%,350px);height:auto;border-radius:10px;border:1px solid #253746}p{max-width:760px;color:#aabacb}</style><main><a href="preview.html">← Videoga qaytish</a><h1>Elonbot: bosqichma-bosqich</h1><p>Animatsiyasiz o'quv qo'llanma. Akkaunt oldindan ulangan. Ma'lumotlar va yuborish natijalari shartli.</p>'''+''.join(steps)+'</main></html>',encoding='utf-8')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--ffmpeg');parser.add_argument('--preview-only',action='store_true');parser.add_argument('--reduced-motion',action='store_true');args=parser.parse_args()
    cache={(i,p):state(i,p) for i in range(len(SCENES)) for p in range(len(PHASES.get(i,[0])))}
    overlays=[overlay(i) for i in range(len(SCENES))]
    assert not CHECKS,json.dumps(CHECKS,ensure_ascii=False,indent=2)
    export_preview(cache,overlays)
    if args.preview_only:print(f'Preview: {len(cache)} UI states; {TOTAL} seconds; no text overflow.');return
    assert args.ffmpeg,'--ffmpeg required'
    filename='elonbot-telegram-uz'+('-reduced-motion' if args.reduced_motion else '')+'.mp4'
    out=ROOT/filename
    cmd=[args.ffmpeg,'-hide_banner','-loglevel','warning','-y','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','21','-pix_fmt','yuv420p','-movflags','+faststart','-metadata','title=Elonbot — Telegram uslubidagi qollanma','-metadata','comment=Educational recreation, synthetic demo content, actual local Mini App captures',str(out)]
    count=0
    with (ROOT/'encode.log').open('w',encoding='utf-8') as log:
        encoder=subprocess.Popen(cmd,stdin=subprocess.PIPE,stderr=log)
        for i,scene in enumerate(SCENES):
            for n in range(scene[1]*FPS):
                encoder.stdin.write(frame(i,n/FPS,count/FPS,cache,overlays,args.reduced_motion).tobytes());count+=1
            print(f'Encoded {i+1}/{len(SCENES)} — {scene[0]}',flush=True)
        encoder.stdin.close();assert encoder.wait()==0,(ROOT/'encode.log').read_text(encoding='utf-8')
    data={'file':filename,'seconds':TOTAL,'width':W,'height':H,'fps':FPS,'frames':count,'ui_states':len(cache),'language':'uz','audio':False,'bytes':out.stat().st_size,'layout_overflow':False,'style':'Telegram-inspired Android night theme; educational recreation','mini_app':'real local test screenshots','motion':'200ms cubic-bezier(.23,1,.32,1); opacity and translation; no camera zoom'}
    (ROOT/'verification.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(data,ensure_ascii=False),flush=True)

if __name__=='__main__':main()
