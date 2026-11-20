"""Small OSC codec: TCP SLIP (OSC 1.1) or big-endian length (OSC 1.0)."""
import socket
import struct
import threading

def string(s):
    b = s.encode('utf-8') + b'\0'
    return b + b'\0' * (-len(b) % 4)

def encode(address, args=()):
    tags, data = ',', b''
    for arg in args:
        if isinstance(arg, str):
            tags += 's'; data += string(arg)
        elif isinstance(arg, int):
            tags += 'i'; data += struct.pack('>i', arg)
        else:
            tags += 'f'; data += struct.pack('>f', arg)
    return string(address) + string(tags) + data

def decode(packet):
    if packet.startswith(b'#bundle\0'):
        pos, result = 16, []
        while pos < len(packet):
            n = struct.unpack_from('>I', packet, pos)[0]; pos += 4
            if not n or pos+n > len(packet): raise ValueError('Invalid bundle')
            result.extend(decode(packet[pos:pos+n])); pos += n
        return result
    def readstr(pos):
        end = packet.index(0, pos)
        return packet[pos:end].decode('utf-8'), (end+4)//4*4
    address, pos = readstr(0)
    if not address.startswith('/'): raise ValueError('Invalid OSC address')
    tags, pos = readstr(pos)
    if not tags.startswith(','): raise ValueError('Invalid OSC tags')
    args = []
    for tag in tags[1:]:
        if tag == 's':
            value, pos = readstr(pos)
        elif tag in 'ifhd':
            fmt, size = {'i':('>i',4),'f':('>f',4),'h':('>q',8),'d':('>d',8)}[tag]
            value = struct.unpack_from(fmt, packet, pos)[0]; pos += size
        elif tag in 'TFN': value = {'T':True,'F':False,'N':None}[tag]
        else: raise ValueError('Unsupported OSC tag ' + tag)
        args.append(value)
    return [(address, args)]

def frame(packet, framing):
    if framing == 'length': return struct.pack('>I', len(packet)) + packet
    return b'\xc0' + packet.replace(b'\xdb', b'\xdb\xdd').replace(b'\xc0', b'\xdb\xdc') + b'\xc0'

class Framer:
    def __init__(self, framing):
        self.framing, self.buffer = framing, bytearray()

    def feed(self, data):
        self.buffer.extend(data)
        if len(self.buffer) > 2**20: raise ValueError('OSC frame too large')
        result = []
        if self.framing == 'length':
            while len(self.buffer) >= 4:
                n = struct.unpack_from('>I', self.buffer)[0]
                if not 0 < n <= 2**20: raise ValueError('Invalid OSC length; check framing')
                if len(self.buffer) < n+4: break
                result.append(bytes(self.buffer[4:n+4])); del self.buffer[:n+4]
        else:
            while 192 in self.buffer:
                end = self.buffer.index(192)
                packet = bytes(self.buffer[:end]); del self.buffer[:end+1]
                if packet: result.append(packet.replace(b'\xdb\xdc',b'\xc0').replace(b'\xdb\xdd',b'\xdb'))
        return result

class Transport:
    def __init__(self, receive, failed, lock=None):
        self.receive, self.failed = receive, failed
        self.sock = None
        self.framing = 'slip'
        # Share the controller's reentrant lock so a retired reader cannot
        # publish feedback or failure after an endpoint or session change.
        self.lock = lock if lock is not None else threading.RLock()

    def connect(self, host, port, framing):
        with self.lock:
            self.close()
            sock = socket.create_connection((host, port), timeout=2)
            sock.settimeout(0.5)
            self.sock, self.framing = sock, framing
            threading.Thread(target=self.reader, args=(sock, framing), daemon=True).start()

    def send(self, address, args=()):
        with self.lock:
            if self.sock is None: raise OSError('Not connected')
            self.sock.sendall(frame(encode(address, args), self.framing))

    def reader(self, sock, framing):
        parser = Framer(framing)
        try:
            while self.sock is sock:
                try: data = sock.recv(65536)
                except socket.timeout: continue
                if not data: raise OSError('Eos closed connection')
                for packet in parser.feed(data):
                    try: messages = decode(packet)
                    except (ValueError, IndexError, struct.error, UnicodeError): continue
                    for address, args in messages:
                        with self.lock:
                            if self.sock is not sock: return
                            self.receive(address, args)
        except (OSError, ValueError) as error:
            with self.lock:
                if self.sock is sock:
                    self.close(); self.failed(str(error))

    def close(self):
        with self.lock:
            sock, self.sock = self.sock, None
            if sock:
                try: sock.shutdown(socket.SHUT_RDWR)
                except OSError: pass
                sock.close()
