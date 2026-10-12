import unittest
from csi_motion import MotionDetector, window_score

def samples(start, count, movement=False, boot='a'):
    result=[]
    for i in range(count):
        iq=[10,0]*64
        if movement and i%2: iq[20:60]=[0,20]*20
        result.append({'boot':boot,'channel':5,'device_ms':start+i*50,'iq':iq})
    return result

class MotionTests(unittest.TestCase):
    def test_quiet_motion_and_boot_invalidation(self):
        d=MotionDetector(); initial=samples(0,1);d.start('m',initial)
        quiet=samples(50,640)
        self.assertEqual(d.state('m',quiet,True)['status'],'quiet')
        self.assertEqual(d.state('m',quiet+samples(32050,50,True),True)['status'],'motion')
        self.assertFalse(d.state('m',quiet,False)['enabled'])
        self.assertFalse(d.state('m',samples(0,40,boot='b'),True)['enabled'])
    def test_gaps_and_invalid_word(self):
        seq=samples(0,40);seq[-1]['device_ms']+=500
        self.assertIsNone(window_score(seq))
        seq=samples(0,40)
        for i,s in enumerate(seq):s['iq'][:4]=[i,-i,i,-i]
        self.assertEqual(window_score(seq),0)
