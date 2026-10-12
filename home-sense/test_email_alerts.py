import unittest,tempfile
from pathlib import Path
from unittest.mock import patch,MagicMock
from email_alerts import EmailAlerts
class EmailTests(unittest.TestCase):
 def test_secret_and_permissions(self):
  with tempfile.TemporaryDirectory() as d:
   a=EmailAlerts(Path(d)/'settings.json');c=dict(recipient='r@example.com',sender='s@example.com',host='smtp.example.com',port=587,security='starttls',username='user',password='secret',enabled=True)
   a.save(c);self.assertNotIn('password',a.status());self.assertEqual(a.path.stat().st_mode&0o777,0o600)
   a.save({**c,'password':''});self.assertEqual(a.config()['password'],'secret')
   with self.assertRaises(ValueError):a.save({**c,'recipient':'r@example.com\nBcc:bad@example.com'})
 def test_tls_and_message(self):
  with tempfile.TemporaryDirectory() as d:
   a=EmailAlerts(Path(d)/'settings.json');c=dict(recipient='r@example.com',sender='s@example.com',host='smtp.example.com',port=587,security='starttls',username='user',password='secret',enabled=True)
   with patch('email_alerts.smtplib.SMTP') as smtp:
    a.send(c,{'room':'Hall','at':'now'},False);client=smtp.return_value.__enter__.return_value
    client.starttls.assert_called_once();client.login.assert_called_once_with('user','secret');m=client.send_message.call_args.args[0];self.assertEqual(m['To'],'r@example.com')
   self.assertFalse(a.enqueue({'source':'recorded'}))
