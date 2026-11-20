import socket
import unittest
from unittest.mock import patch
import diagnostics
from osc import Framer, decode, encode, frame

class Route:
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def connect(self,target): pass
    def getsockname(self): return ('169.254.40.147',12345)

class Peer(Route):
    def __init__(self): self.sent=[]
    def settimeout(self,value): pass
    def sendall(self,data): self.sent.append(data)
    def recv(self,size): return frame(encode('/eos/out/get/version',['3.3.10']),'length')

class DiagnosticsTests(unittest.TestCase):
    endpoint=dict(host='169.254.44.253',port=3038,framing='length')
    def test_probe_reads_identity_without_output_commands(self):
        peer=Peer();steps=[]
        with patch.object(diagnostics.socket,'socket',return_value=Route()),patch.object(diagnostics.socket,'create_connection',return_value=peer),patch.object(diagnostics.subprocess,'run',side_effect=OSError('no ping')):
            result=diagnostics.probe(self.endpoint,lambda *s:steps.append(s))
        addresses=[]
        for packet in peer.sent:
            for data in Framer('length').feed(packet): addresses.extend(a for a,args in decode(data))
        self.assertEqual(addresses,['/eos/get/version','/eos/get/show/path','/eos/ping'])
        self.assertIn('Connection works',result)
        self.assertTrue(any(name=='OSC feedback' and status=='pass' for name,status,_ in steps))
    def test_timeout_reports_tcp_stage(self):
        steps=[]
        with patch.object(diagnostics.socket,'socket',return_value=Route()),patch.object(diagnostics.socket,'create_connection',side_effect=TimeoutError('timed out')),patch.object(diagnostics.subprocess,'run',side_effect=OSError('no ping')):
            result=diagnostics.probe(self.endpoint,lambda *s:steps.append(s))
        self.assertIn('TCP 3038 did not open',result)
        self.assertEqual(steps[-1][0:2],('TCP connection','fail'))

if __name__=='__main__': unittest.main()
