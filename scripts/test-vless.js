// Быстрая проверка парсера: node scripts/test-vless.js   (только фиктивные данные!)
const assert = require('assert');
const V = require('../html/js/vless.js');

const fake = 'vless://11111111-2222-3333-4444-555555555555@example.com:443' +
  '?type=tcp&security=reality&flow=xtls-rprx-vision&sni=www.example.org&fp=chrome' +
  '&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=abcd1234&spx=%2F#Test%20Server';

const p = V.parseVless(fake);
assert.strictEqual(p.address, 'example.com');
assert.strictEqual(p.port, 443);
assert.strictEqual(p.name, 'Test Server');
assert.strictEqual(p.security, 'reality');

const cfg = V.buildSingBoxConfig(p, { mode: 'tun', clashSecret: 's' });
const ob = cfg.outbounds[0];
assert.strictEqual(ob.type, 'vless');
assert.strictEqual(ob.flow, 'xtls-rprx-vision');
assert.strictEqual(ob.tls.reality.enabled, true);
assert.strictEqual(ob.tls.reality.short_id, 'abcd1234');
assert.strictEqual(cfg.inbounds[0].type, 'tun');
assert.strictEqual(V.buildSingBoxConfig(p, { mode: 'proxy' }).inbounds[0].type, 'mixed');

// IPv6 + ws
const ws = V.parseVless('vless://11111111-2222-3333-4444-555555555555@[2001:db8::1]:8443?type=ws&security=tls&sni=a.b&path=%2Fws&host=a.b');
assert.strictEqual(ws.address, '2001:db8::1');
assert.strictEqual(V.buildOutbound(ws).transport.type, 'ws');

// Ошибки
for (const bad of ['http://x', 'vless://bad@h:1', fake.replace('pbk=', 'x='), fake.replace('type=tcp', 'type=ws')]) {
  assert.throws(() => V.parseVless(bad), bad);
}
assert.strictEqual(V.extractLinks(`a\n${fake}\n  ${fake}`).length, 2);
console.log('vless.js: все проверки пройдены');
