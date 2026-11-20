"""Named motion commands remain an explicit, debounced cue allowlist."""
import copy
import math
from pathlib import Path
import tempfile
import unittest

from app import Controller, DEFAULT, validate


class Clock:
    def __init__(self): self.now=100.0
    def __call__(self): return self.now
    def advance(self,seconds): self.now+=seconds


class FakeTransport:
    def __init__(self): self.sent=[]
    def send(self,address,args=()): self.sent.append((address,list(args)))
    def connect(self,**kwargs): pass
    def close(self): pass


def motion(identifier='motion_wave_0001',name='Wave right',cue='1200',enabled=True):
    frames=[]
    for i in range(32):
        row=[0.0]*38
        row[0]=1.0
        row[1]=i/31
        row[2]=.25*math.sin(i/31*math.pi)
        frames.append(row)
    return dict(id=identifier,name=name,enabled=enabled,cue_list=1,cue=cue,
                threshold=.85,cooldown_s=2.0,feature_version='hand-v1',
                templates=[dict(duration_s=2.0,frames=frames)])


def config_with(*motions):
    config=copy.deepcopy(DEFAULT)
    config.update(mode='motion',dry_run=True,custom_motions=list(motions))
    return config


class CustomMotionValidationTests(unittest.TestCase):
    def test_valid_trained_motion_and_mode_survive_validation(self):
        result=validate(config_with(motion()))
        self.assertEqual(result['mode'],'motion')
        self.assertEqual(result['custom_motions'][0]['name'],'Wave right')
        self.assertEqual(len(result['custom_motions'][0]['templates'][0]['frames']),32)

    def test_rejects_invalid_ids_names_and_cue_injection(self):
        for key,value in [('id','motion_/eos/cmd'),('name',''),('name',' '*4),
                          ('name','x'*81),('cue','1/fire'),('cue_list',0),
                          ('enabled','true'),('feature_version','arbitrary-model')]:
            with self.subTest(key=key,value=value):
                sample=motion();sample[key]=value
                with self.assertRaises(ValueError):validate(config_with(sample))

    def test_rejects_unbounded_similarity_and_cooldown(self):
        for key,value in [('threshold',float('nan')),('threshold',.1),
                          ('threshold',1.0),('cooldown_s',.1),('cooldown_s',11)]:
            with self.subTest(key=key,value=value):
                sample=motion();sample[key]=value
                with self.assertRaises(ValueError):validate(config_with(sample))

    def test_rejects_missing_or_malformed_recordings(self):
        variants=[]
        sample=motion();sample['templates']=[];variants.append(sample)
        sample=motion();sample['templates']*=4;variants.append(sample)
        sample=motion();sample['templates'][0]['duration_s']=.1;variants.append(sample)
        sample=motion();sample['templates'][0]['duration_s']=7;variants.append(sample)
        sample=motion();sample['templates'][0]['frames'].pop();variants.append(sample)
        sample=motion();sample['templates'][0]['frames'][0].pop();variants.append(sample)
        sample=motion();sample['templates'][0]['frames'][0][0]=float('nan');variants.append(sample)
        sample=motion();sample['templates'][0]['frames'][0][0]=100;variants.append(sample)
        for index,sample in enumerate(variants):
            with self.subTest(index=index),self.assertRaises(ValueError):validate(config_with(sample))

    def test_names_and_ids_are_unique_and_count_is_bounded(self):
        first=motion()
        for second in [motion(name='Different'),motion(identifier='motion_other_0002',name='WAVE RIGHT')]:
            with self.assertRaises(ValueError):validate(config_with(first,second))
        samples=[motion(identifier=f'motion_example_{i:04}',name=f'Example {i}') for i in range(21)]
        with self.assertRaises(ValueError):validate(config_with(*samples))


class CustomMotionControllerTests(unittest.TestCase):
    def setUp(self):
        # Keep scratch writes within the task workspace on sandboxed Windows.
        scratch=Path(__file__).resolve().parents[3]/'work'
        scratch.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=scratch)
        self.clock=Clock()
        self.c=Controller(self.temp.name,self.clock)
        self.c.transport=FakeTransport()
        self.first=motion()
        self.c.apply(config_with(self.first))
        self.action('claim')

    def tearDown(self): self.temp.cleanup()
    def action(self,name,**data):return self.c.action(name,data,'motion-test-browser')
    def live(self):
        self.c.config['dry_run']=False
        self.c.connected=True
        self.c.receive('/eos/out/get/version',['3.3.10'])
    def frame(self,identifier=None,similarity=.99):
        candidate=None if identifier is None else dict(id=identifier,similarity=similarity)
        return self.action('frame',source='camera',gesture='None',confidence=0,
                           hands=[],motion_candidate=candidate)
    def dry_cues(self):
        return [item for item in self.c.logs if item['kind']=='DRY' and item['message'].startswith('/eos/cue/')]
    def neutral(self):
        self.frame()
        self.clock.advance(.61)
        self.frame()

    def test_dry_run_match_logs_exact_cue_without_network_output(self):
        self.action('arm')
        self.frame(self.first['id'])
        self.assertEqual(self.c.transport.sent,[])
        self.assertEqual(len(self.dry_cues()),1)
        self.assertIn('/eos/cue/1/1200/fire',self.dry_cues()[0]['message'])

    def test_unknown_disabled_and_low_similarity_cannot_fire(self):
        disabled=motion(identifier='motion_disabled_0002',name='Disabled',enabled=False)
        self.c.apply(config_with(self.first,disabled))
        self.action('arm')
        for identifier,score in [('motion_unknown_9999',1),(disabled['id'],1),(self.first['id'],.84)]:
            try:self.frame(identifier,score)
            except ValueError:pass  # Explicit rejection is also a safe response.
        self.assertEqual(self.dry_cues(),[])
        self.assertEqual(self.c.transport.sent,[])

    def test_held_match_does_not_repeat_and_neutral_rearms(self):
        self.action('arm')
        self.frame(self.first['id'])
        for _ in range(20):
            self.clock.advance(.2);self.frame(self.first['id'])
        self.assertEqual(len(self.dry_cues()),1)
        self.neutral()
        self.frame(self.first['id'])
        self.assertEqual(len(self.dry_cues()),2)

    def test_custom_cooldown_still_applies_after_neutral(self):
        self.action('arm')
        self.frame(self.first['id'])
        self.neutral()
        self.clock.advance(.5)
        self.frame(self.first['id'])
        self.assertEqual(len(self.dry_cues()),1)
        self.neutral()
        # The same cue also has a shared duplicate suppression window.
        self.clock.advance(1.4)
        self.frame(self.first['id'])
        self.assertEqual(len(self.dry_cues()),2)

    def test_live_arm_requires_manual_test_for_each_enabled_motion(self):
        second=motion(identifier='motion_second_0002',name='Wave left',cue='1201')
        self.c.apply(config_with(self.first,second))
        self.live()
        flags=dict(only_host=True,session_ok=True,cue_ok=True)
        with self.assertRaises(ValueError):self.action('arm',**flags)
        self.action('manual_motion',id=self.first['id'],**flags)
        self.assertIn(self.first['id'],self.c.tested_motions)
        with self.assertRaises(ValueError):self.action('arm',**flags)
        self.clock.advance(self.c.config['cue_interval_s'])
        self.action('heartbeat')
        self.c.receive('/eos/out/ping',[])
        self.action('manual_motion',id=second['id'],**flags)
        self.action('arm',**flags)
        self.assertTrue(self.c.armed)
        self.assertIn(('/eos/cue/1/1200/fire',[]),self.c.transport.sent)
        self.assertIn(('/eos/cue/1/1201/fire',[]),self.c.transport.sent)

    def test_dry_manual_test_does_not_satisfy_live_gate(self):
        self.action('manual_motion',id=self.first['id'])
        self.assertNotIn(self.first['id'],self.c.tested_motions)
        self.live()
        with self.assertRaises(ValueError):self.action('arm',only_host=True,session_ok=True,cue_ok=True)

    def test_rate_limited_manual_motion_is_not_reported_as_sent(self):
        second=motion(identifier='motion_second_0002',name='Wave left',cue='1201')
        self.c.apply(config_with(self.first,second))
        self.live()
        flags=dict(only_host=True,session_ok=True)
        self.action('manual_motion',id=self.first['id'],**flags)
        with self.assertRaisesRegex(ValueError,'Wait .*seconds'):
            self.action('manual_motion',id=second['id'],**flags)
        self.assertNotIn(second['id'],self.c.tested_motions)
        self.assertEqual(self.c.transport.sent,[('/eos/cue/1/1200/fire',[])])
        self.clock.advance(self.c.config['cue_interval_s'])
        self.action('heartbeat')
        self.c.receive('/eos/out/ping',[])
        self.action('manual_motion',id=second['id'],**flags)
        self.assertIn(second['id'],self.c.tested_motions)
        self.assertEqual(self.c.transport.sent[-1],('/eos/cue/1/1201/fire',[]))

    def test_manual_motion_rejects_unknown_id_and_camera_armed(self):
        with self.assertRaises(ValueError):self.action('manual_motion',id='motion_unknown_9999')
        self.action('arm')
        with self.assertRaises(ValueError):self.action('manual_motion',id=self.first['id'])
        self.assertEqual(self.dry_cues(),[])

    def test_empty_enabled_set_cannot_arm_even_dry(self):
        self.c.apply(config_with(motion(enabled=False)))
        with self.assertRaises(ValueError):self.action('arm')

    def test_identical_apply_preserves_custom_manual_test_receipt(self):
        self.live()
        self.action('manual_motion',id=self.first['id'],only_host=True,session_ok=True)
        self.assertIn(self.first['id'],self.c.tested_motions)
        self.c.apply(copy.deepcopy(self.c.config))
        self.assertFalse(self.c.armed)
        self.assertEqual(self.c.tested_motions,{self.first['id']})

    def test_watchdog_stops_custom_motion_output(self):
        self.action('arm')
        self.clock.advance(1.6)
        self.c.tick()
        self.assertFalse(self.c.armed)
        with self.assertRaises(ValueError):self.frame(self.first['id'])
        self.assertEqual(self.dry_cues(),[])


if __name__=='__main__':unittest.main()
