"""Read-only connection probe. Never sends cue, override, or release commands."""
import json
import os
import socket
import struct
import subprocess
import time
from osc import Framer, decode, encode, frame

QUERIES = [('/eos/get/version', ()), ('/eos/get/show/path', ()), ('/eos/ping', ('gesture-eos-connection-test',))]

def probe(endpoint, report):
    """Report staged results, returning a short operator-facing conclusion."""
    host, port, framing = endpoint['host'], endpoint['port'], endpoint['framing']
    report('Endpoint', 'info', f'{host}:{port} · OSC ' + ('1.0 / packet length' if framing=='length' else '1.1 / SLIP'))
    try:
        # UDP connect selects a route but sends no datagram.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
            route.connect((host, port))
            local_ip = route.getsockname()[0]
        report('Laptop route', 'pass', f'Windows selected local address {local_ip} for this console.')
    except OSError as error:
        report('Laptop route', 'fail', str(error))
        return 'No usable route to the console. Check the Ethernet adapter and approved IP/subnet.'
    try:
        command = ['ping','-n','1','-w','1200',host] if os.name=='nt' else ['ping','-c','1',host]
        result = subprocess.run(command,capture_output=True,text=True,timeout=3,
            **({'creationflags':subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {}))
        reachable = result.returncode==0
        report('Network ping', 'pass' if reachable else 'info', result.stdout.strip() or result.stderr.strip() or 'No ICMP reply; TCP test will still run.')
    except (OSError,subprocess.TimeoutExpired) as error:
        report('Network ping', 'info', 'Ping unavailable or timed out; TCP test will still run. '+str(error))
    start = time.monotonic()
    try:
        sock = socket.create_connection((host,port),timeout=2)
    except OSError as error:
        report('TCP connection','fail',str(error))
        return f'TCP {port} did not open. Check the console OSC TCP server port, interface, and IP/subnet. UDP RX 8000 is a different setting.'
    report('TCP connection','pass',f'Connected in {(time.monotonic()-start)*1000:.0f} ms.')
    messages, raw_bytes = [], 0
    with sock:
        sock.settimeout(.3)
        try:
            for address,args in QUERIES:
                sock.sendall(frame(encode(address,args),framing))
            report('OSC requests','pass','Sent read-only /eos/get/version, /eos/get/show/path and /eos/ping.')
            parser=Framer(framing)
            deadline=time.monotonic()+3
            while time.monotonic()<deadline:
                try: data=sock.recv(65536)
                except socket.timeout: continue
                if not data: break
                raw_bytes+=len(data)
                for packet in parser.feed(data):
                    try: messages.extend(decode(packet))
                    except (ValueError,IndexError,UnicodeError,struct.error): continue
                identity=[(a,args) for a,args in messages if a in ('/eos/out/get/version','/eos/out/get/show/path','/eos/out/show/name') and args]
                if identity: break
        except (OSError,ValueError) as error:
            report('OSC feedback','fail',str(error))
            return 'TCP opened, but OSC feedback failed. Confirm packet-length versus SLIP framing on the console.'
    eos=[(a,args) for a,args in messages if a.startswith('/eos/out/')]
    if eos:
        identity=[(a,args) for a,args in eos if a in ('/eos/out/get/version','/eos/out/get/show/path','/eos/out/show/name') and args]
        visible=identity+[(a,args) for a,args in eos if (a,args) not in identity]
        report('OSC feedback','pass','\n'.join(a+' '+json.dumps(args) for a,args in visible[:12]))
        if identity:
            return 'Connection works: TCP and readable Eos identity feedback passed. No cue was fired.'
        return 'Eos OSC replies received. Version/show identity was not returned; check console feedback settings before arming.'
    report('OSC feedback','fail',f'{raw_bytes} bytes received; no readable Eos reply using the selected framing.')
    return 'TCP opened, but no readable Eos feedback arrived. Check OSC TX, framing, and console interface settings.'
