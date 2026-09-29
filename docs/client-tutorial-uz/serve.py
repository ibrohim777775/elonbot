"""Local-only preview server with byte ranges for MP4 seeking."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):
        self.video_range=None
        super().__init__(*args,directory=str(ROOT),**kwargs)

    def send_head(self):
        self.video_range=None
        target=Path(self.translate_path(self.path))
        if target.suffix.lower()!='.mp4' or not target.is_file():
            return super().send_head()
        size=target.stat().st_size
        range_header=self.headers.get('Range')
        start,end=0,size-1
        if range_header:
            match=re.fullmatch(r'bytes=(\d*)-(\d*)',range_header)
            if not match or not any(match.groups()):
                self.send_error(416)
                return None
            if not match[1]:
                start=max(0,size-int(match[2]))
            else:
                start=int(match[1])
                end=min(end,int(match[2])) if match[2] else end
            if start>=size or end<start:
                self.send_error(416)
                return None
        source=target.open('rb')
        source.seek(start)
        self.video_range=end-start+1
        self.send_response(206 if range_header else 200)
        self.send_header('Content-Type','video/mp4')
        self.send_header('Accept-Ranges','bytes')
        self.send_header('Content-Length',str(self.video_range))
        if range_header:
            self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.end_headers()
        return source

    def copyfile(self,source,outputfile):
        if self.video_range is None:
            return super().copyfile(source,outputfile)
        remaining=self.video_range
        try:
            while remaining>0:
                chunk=source.read(min(remaining,65536))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining-=len(chunk)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):
            pass

if __name__=='__main__':
    server=ThreadingHTTPServer(('127.0.0.1',8776),Handler)
    print('http://127.0.0.1:8776/preview.html',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
