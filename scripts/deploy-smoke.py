#!/usr/bin/env python3
"""Real HTTPS production-container acceptance. Creates persistent test accounts.

Only localhost is accepted: never point destructive test setup at a public demo.
Usage: python3 scripts/deploy-smoke.py --ca /tmp/caddy-root.crt
"""
import argparse
import http.cookiejar
import json
import secrets
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='https://localhost:8443')
parser.add_argument('--ca', required=True)
args = parser.parse_args()
parsed = urllib.parse.urlparse(args.base)
assert parsed.scheme == 'https' and parsed.hostname in ('localhost', '127.0.0.1'), 'Isolated local HTTPS only'
context = ssl.create_default_context(cafile=args.ca)


class Player:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.http = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, path, body=None, expected=200, key=None):
        headers = {'Origin': args.base}
        if body is not None:
            headers.update({'Content-Type': 'application/json', 'Idempotency-Key': key or str(uuid.uuid4())})
        request = urllib.request.Request(args.base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            response = self.http.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        payload = response.read()
        assert response.status == expected, (path, response.status, payload.decode())
        return json.loads(payload) if payload and response.headers.get('Content-Type', '').startswith('application/json') else payload

    def state(self):
        return self.call('/api/state')

    def action(self, action, body, key=None):
        return self.call('/api/game/' + action, body, expected=201, key=key)


start = time.monotonic()
a, b, guest = Player(), Player(), Player()
assert a.call('/api/ready')['ok']
assert b'<html' in a.call('/').lower()
assert b'<html' in a.call('/admin/').lower()
a.call('/api/metrics', expected=404)
a.call('/api/state', expected=401)
password = secrets.token_hex(18)
email = 'smoke-a-' + uuid.uuid4().hex[:10] + '@example.test'
a.call('/api/auth/register', {'email': email, 'password': password, 'name': 'HTTPS smoke A'}, expected=201)
b.call('/api/auth/register', {'email': 'smoke-b-' + uuid.uuid4().hex[:10] + '@example.test', 'password': password, 'name': 'HTTPS smoke B'}, expected=201)
assert all(cookie.secure for cookie in a.jar), 'Production session must be Secure'
a.call('/api/admin', expected=403)
for drop in a.state()['salvage']:
    a.action('salvage', {'spawnId': drop['id']})
a.action('build', {'kind': 'purifier', 'x': 0, 'y': 0})
purifier = next(building for building in a.state()['buildings'] if building['kind'] == 'purifier')
for _ in range(2):
    a.action('produce', {'buildingId': purifier['id']})
a.call('/api/auth/logout', {}, expected=201)
# All advancement happens in persisted jobs on server time, while logged out.
time.sleep(25)
a.call('/api/auth/login', {'email': email, 'password': password}, expected=201)
assert a.state()['offlineReady'] == 2
a.action('collect', {'buildingId': purifier['id']})
assert a.state()['inventory']['water'] == 6
order = next(order for order in a.state()['orders'] if order['input'].get('water') == 3)
a.action('order', {'orderId': order['id']})
assert a.state()['stats']['orders'] == 1
a.action('build', {'kind': 'dock', 'x': 1, 'y': 0})
b.action('build', {'kind': 'dock', 'x': 0, 'y': 0})
listing = a.call('/api/market', {'resource': 'water', 'quantity': 2, 'unitPrice': 7}, expected=201)
a_before, b_before = a.state(), b.state()
key = str(uuid.uuid4())
first = b.call('/api/market/' + listing['id'] + '/buy', {'quantity': 2}, expected=201, key=key)
assert first == b.call('/api/market/' + listing['id'] + '/buy', {'quantity': 2}, expected=201, key=key)
a_after, b_after = a.state(), b.state()
assert a_after['coins'] == a_before['coins'] + 13
assert b_after['coins'] == b_before['coins'] - 14
assert b_after['inventory']['water'] == b_before['inventory'].get('water', 0) + 2
assert len(b.call('/api/market/history')) == 1
b.call('/api/friends/' + a_after['id'], {}, expected=201)
assert len(b.call('/api/friends')) == 1
assert b.call('/api/players/' + a_after['id'] + '/island')['id'] == a_after['id']
assert len(b.call('/api/leaderboard')) >= 2
# Guest mode is backed by the same persisted server economy.
guest.call('/api/auth/guest', {}, expected=201)
guest_before = guest.state()
assert guest_before['isGuest'] and guest_before['guestExpiresAt']
guest.action('salvage', {'spawnId': guest_before['salvage'][0]['id']})
assert guest.state()['stats']['salvaged'] == 1
print(json.dumps({'result': 'passed', 'transport': 'HTTPS with validated private CA', 'checks': ['secure session', 'registration/login', 'salvage', 'build', 'production', 'logout/offline recovery', 'order', 'two-account market purchase', 'idempotent retry', 'coins/inventory/history', 'friend/visit', 'leaderboard', 'restricted persistent guest', 'admin denial', 'metrics not public'], 'durationSeconds': round(time.monotonic() - start, 2)}, ensure_ascii=False))
