import copy
import json
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock
from app import Controller, DEFAULT, GestureGate, validate
from osc import encode, decode, frame, Framer, Transport

class Clock:
    def __init__(self): self.now=100
    def __call__(self): return self.now
    def advance(self,n): self.now+=n

class FakeTransport:
    def __init__(self): self.sent=[]; self.fail=False
    def send(self,a,args=()):
        if self.fail: raise OSError('cable removed')
        self.sent.append((a,list(args)))
    def connect(self,**kw): self.fail=False
    def close(self): pass

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.clock=Clock()
        self.c=Controller(self.temp.name,self.clock); self.c.transport=FakeTransport()
        self.c.config['mappings'][0]['enabled']=True
        self.c.config['mappings'][0]['cue']='600'
        self.c.config['mappings'][0]['enabled']=False
        self.c.config['mappings'][1].update(enabled=True,cue='600')
        self.c.config['palm_from_fist']=False
        self.c.action('claim',{},'test-browser')
    def tearDown(self): self.temp.cleanup()
    def action(self,name,**data): return self.c.action(name,data,'test-browser')
    def live(self):
        self.c.config['dry_run']=False; self.c.connected=True
        self.c.receive('/eos/out/get/version',['3.3.10'])
    def zoom_config(self):
        self.c.config.update(mode='zoom',target='28',zoom_min=10,zoom_max=60,close=.1,far=.8)
    def test_defaults_disarmed_dry(self):
        self.assertFalse(self.c.armed); self.assertTrue(self.c.config['dry_run'])
    def test_config_rejects_injection_nan_bad_ranges(self):
        for key,val in [('target','1/param/intens'),('host','8.8.8.8'),('alpha',float('nan')),('framing','udp'),('parameter','intens'),('dry_run','false')]:
            with self.subTest(key=key),self.assertRaises(ValueError): validate(dict(DEFAULT,**{key:val}))
        with self.assertRaises(ValueError): validate(dict(DEFAULT,zoom_min=60,zoom_max=10))
    def test_mapping_validation(self):
        c=copy.deepcopy(DEFAULT); c['mappings'][0].update(enabled=True,cue='1/fire')
        with self.assertRaises(ValueError): validate(c)
        c['mappings'][0].update(cue='1.5',confidence=.2)
        with self.assertRaises(ValueError): validate(c)
    def test_all_mapped_gestures_fire_once(self):
        mappings=copy.deepcopy(DEFAULT['mappings'])
        for i,m in enumerate(mappings): m.update(enabled=True,cue=str(i+1))
        gate=GestureGate(); fires=[]; now=0
        for m in mappings:
            gate.update('None',0,mappings,now); now+=.31; gate.update('None',0,mappings,now)
            for _ in range(35):
                now+=.1; hit=gate.update(m['gesture'],.99,mappings,now)
                if hit: fires.append(hit['cue'])
        self.assertEqual(fires,['1','2','3','4','5'])
    def test_no_neutral_no_repeat_or_transition_fire(self):
        mappings=copy.deepcopy(self.c.config['mappings']); mappings[2].update(enabled=True,cue='2')
        gate=GestureGate();gate.update('None',0,mappings,0);gate.update('None',0,mappings,.31)
        self.assertIsNone(gate.update('Open_Palm',.99,mappings,.4))
        self.assertIsNotNone(gate.update('Open_Palm',.99,mappings,1.1))
        for t in [2,3,4]: self.assertIsNone(gate.update('Closed_Fist',.99,mappings,t))
    def test_brief_wrong_pose_never_fires(self):
        gate=GestureGate();m=self.c.config['mappings']
        gate.update('None',0,m,0);gate.update('None',0,m,.31)
        for t in [1,2,3]:
            self.assertIsNone(gate.update('Open_Palm',.9,m,t))
            self.assertIsNone(gate.update('None',0,m,t+.1))
    def test_dry_run_no_transmission(self):
        self.action('manual_cue',gesture='Open_Palm')
        self.assertEqual(self.c.transport.sent,[])
        self.assertTrue(any('/eos/cue/1/600/fire' in e['message'] for e in self.c.logs))
    def test_live_requires_feedback_and_confirmation(self):
        self.c.config['dry_run']=False
        with self.assertRaises(ValueError): self.action('manual_cue',gesture='Open_Palm',only_host=True,session_ok=True)
        self.live()
        with self.assertRaises(ValueError): self.action('manual_cue',gesture='Open_Palm')
        self.action('manual_cue',gesture='Open_Palm',only_host=True,session_ok=True)
        self.assertTrue(self.c.cue_tested)
    def test_arm_requires_manual_test(self):
        self.live()
        with self.assertRaises(ValueError): self.action('arm',only_host=True,session_ok=True,cue_ok=True)
        self.action('manual_cue',gesture='Open_Palm',only_host=True,session_ok=True)
        self.action('arm',only_host=True,session_ok=True,cue_ok=True)
        self.assertTrue(self.c.armed)
    def test_cue_rate_limit(self):
        self.live()
        self.action('manual_cue',gesture='Open_Palm',only_host=True,session_ok=True)
        for _ in range(19):
            with self.assertRaisesRegex(ValueError,'Wait .*seconds'):
                self.action('manual_cue',gesture='Open_Palm',only_host=True,session_ok=True)
        self.assertEqual(len(self.c.transport.sent),1)
    def test_zoom_clamps_smooths_and_releases_on_hand_loss(self):
        self.zoom_config();self.action('arm')
        values=[]
        for distance in [0,.2,.4,.8,2]:
            self.clock.advance(.1)
            self.action('frame',source='camera',gesture='None',confidence=0,hands=[{'confidence':.99}]*2,distance=distance)
            values.append(self.c.telemetry['output'])
        self.assertEqual(values,sorted(values));self.assertTrue(all(10<=v<=60 for v in values))
        self.action('frame',hands=[{'confidence':.99}],confidence=0)
        self.clock.advance(.81);self.c.tick();self.assertFalse(self.c.dry_owned)
    def test_low_confidence_hands_cannot_hold_override(self):
        self.zoom_config();self.action('arm');self.c.zoom(30)
        self.clock.advance(.81)
        self.action('frame',hands=[{'confidence':.1}]*2,confidence=0,distance=.5)
        self.c.tick();self.assertFalse(self.c.dry_owned)
    def test_zoom_rejects_out_of_range_and_limits_rate(self):
        self.zoom_config()
        with self.assertRaises(ValueError):self.c.zoom(100)
        self.assertTrue(self.c.zoom(30));self.assertFalse(self.c.zoom(40))
        self.clock.advance(.1);self.assertFalse(self.c.zoom(30.1))
    def test_reverse(self):
        self.zoom_config();self.c.config.update(reverse=True,alpha=1);self.action('arm')
        self.action('frame',hands=[{'confidence':1}]*2,confidence=0,distance=.1)
        self.assertEqual(self.c.telemetry['output'],60)
    def test_watchdog_releases_live_override(self):
        self.zoom_config();self.live();self.c.zoom(30)
        self.clock.advance(1.6);self.c.tick()
        self.assertFalse(self.c.armed);self.assertFalse(self.c.pending)
        self.assertIn(('/eos/chan/28/param/zoom/release',[]),self.c.transport.sent)
    def test_camera_freeze_disarms_despite_browser_heartbeat(self):
        self.action('arm');self.clock.advance(1.6);self.action('heartbeat');self.c.tick()
        self.assertFalse(self.c.armed)
    def test_release_survives_network_failure_and_restart(self):
        self.zoom_config();self.live();self.c.zoom(30);self.c.transport.fail=True
        with self.assertRaises(ValueError):self.action('stop')
        self.assertEqual(len(self.c.pending),1)
        recovered=Controller(self.temp.name,self.clock);recovered.transport=FakeTransport()
        recovered.connect();self.assertFalse(recovered.pending)
        self.assertEqual(recovered.transport.sent[0][0],'/eos/chan/28/param/zoom/release')
        self.assertFalse(recovered.armed)
    def test_target_change_releases_old_target(self):
        self.zoom_config();self.live();self.c.zoom(30)
        cfg=copy.deepcopy(self.c.config);cfg['target']='29';self.c.apply(cfg)
        self.assertIn(('/eos/chan/28/param/zoom/release',[]),self.c.transport.sent)
        self.assertFalse(self.c.pending)
    def test_second_tab_blocked_but_can_stop(self):
        with self.assertRaises(ValueError):self.c.action('arm',{},'other-browser')
        self.action('arm');self.c.action('stop',{},'other-browser');self.assertFalse(self.c.armed)
    def test_live_demo_rejected(self):
        self.live();self.c.armed=True
        with self.assertRaises(ValueError):self.action('frame',source='demo')
    def test_live_zoom_arm_needs_explicit_release(self):
        self.live();self.zoom_config()
        flags=dict(only_host=True,session_ok=True,zoom_ok=True)
        self.action('manual_zoom',value=30,**flags)
        with self.assertRaises(ValueError):self.action('arm',**flags)
        self.action('release');self.action('arm',**flags);self.assertTrue(self.c.armed)

class ProtocolTests(unittest.TestCase):
    def test_fragmented_and_coalesced_frames(self):
        packet=encode('/eos/out/get/version',['Eos',3,3.5])
        for framing in ['slip','length']:
            parser=Framer(framing);result=[]
            for b in frame(packet,framing)*2:result.extend(parser.feed(bytes([b])))
            self.assertEqual(len(result),2);self.assertEqual(decode(result[0]),[('/eos/out/get/version',['Eos',3,3.5])])
    def test_slip_escapes(self):
        packet=bytes([0,192,219,1]);self.assertEqual(Framer('slip').feed(frame(packet,'slip')),[packet])

    def test_retired_socket_cannot_deliver_feedback_or_eof(self):
        feedback=frame(encode('/eos/out/show/name',['Previous show']),'slip')
        for data in (feedback,b''):
            with self.subTest(event='feedback' if data else 'EOF'):
                owner=threading.current_thread()
                reader_waiting=threading.Event()
                lock=threading.RLock()

                class ControllerLock:
                    def __enter__(self):
                        if threading.current_thread() is not owner:reader_waiting.set()
                        lock.acquire()

                    def __exit__(self,*exc):
                        lock.release()

                receive,failed=Mock(),Mock()
                tr=Transport(receive,failed,lock=ControllerLock())
                old,new=Mock(),Mock()
                old.recv.return_value=data
                tr.sock=old
                worker=threading.Thread(target=tr.reader,args=(old,'slip'),daemon=True)
                with tr.lock:
                    worker.start()
                    # The reader already has feedback or EOF while the
                    # controller retires its socket and installs the next one.
                    self.assertTrue(reader_waiting.wait(2))
                    tr.close()
                    tr.sock=new
                worker.join(2)
                self.assertFalse(worker.is_alive())
                self.assertIs(tr.sock,new)
                receive.assert_not_called()
                failed.assert_not_called()
                new.close.assert_not_called()

    def test_current_socket_delivers_feedback_and_reports_eof(self):
        receive,failed=Mock(),Mock()
        tr=Transport(receive,failed)
        current=Mock()
        current.recv.side_effect=[frame(encode('/eos/out/show/name',['Current show']),'slip'),b'']
        tr.sock=current
        tr.reader(current,'slip')
        receive.assert_called_once_with('/eos/out/show/name',['Current show'])
        failed.assert_called_once_with('Eos closed connection')
        current.close.assert_called_once()
        self.assertIsNone(tr.sock)

    def test_real_tcp_mock_both_framings(self):
        for framing in ['slip','length']:
            server=socket.socket();server.bind(('127.0.0.1',0));server.listen(1)
            event=threading.Event();received=[];errors=[]
            def peer():
                conn,_=server.accept()
                with conn:
                    parser=Framer(framing)
                    while True:
                        data=conn.recv(4096)
                        if not data:return
                        messages=parser.feed(data)
                        if messages:
                            received.extend(decode(messages[0]))
                            packet=frame(encode('/eos/out/get/version',['Mock Eos']),framing)
                            conn.sendall(packet[:3]);conn.sendall(packet[3:]);event.wait(2);return
            t=threading.Thread(target=peer);t.start()
            tr=Transport(lambda a,args:event.set(),errors.append)
            try:
                tr.connect('127.0.0.1',server.getsockname()[1],framing);tr.send('/eos/get/version')
                self.assertTrue(event.wait(2));self.assertEqual(received[0][0],'/eos/get/version')
            finally:tr.close();server.close();t.join(2)

if __name__=='__main__':unittest.main()
