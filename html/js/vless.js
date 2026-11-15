/**
 * vless.js — разбор vless:// ссылок и генерация конфига sing-box.
 * Целевая версия ядра: sing-box >= 1.12 (новый формат DNS-серверов и rule actions).
 *
 * Формат ссылки:
 *   vless://<uuid>@<host>:<port>?type=tcp&security=reality&flow=xtls-rprx-vision
 *          &sni=example.com&fp=chrome&pbk=<publicKey>&sid=<shortId>&spx=%2F#Имя
 */
(function (global) {
  'use strict';

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LINK_RE = /^vless:\/\/([^@\/?#]+)@(\[[^\]]+\]|[^:\/?#]+):(\d{1,5})\/?(?:\?([^#]*))?(?:#(.*))?$/i;
  const TRANSPORTS = ['tcp', 'ws', 'grpc', 'http', 'httpupgrade'];
  const FINGERPRINTS = ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'randomized'];

  /** Безопасный decodeURIComponent: при ошибке возвращает исходную строку. */
  function dec(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }

  /**
   * Разбирает vless:// ссылку. Бросает Error с понятным сообщением на русском.
   * @returns {{uuid,address,port,name,type,security,flow,sni,fp,pbk,sid,spx,alpn,path,host,serviceName,encryption,allowInsecure}}
   */
  function parseVless(raw) {
    const link = String(raw || '').trim();
    const m = LINK_RE.exec(link);
    if (!m) throw new Error('Неверный формат: ожидается vless://uuid@host:port?...');

    const uuid = dec(m[1]);
    if (!UUID_RE.test(uuid)) throw new Error('UUID имеет неверный формат');

    let address = m[2];
    if (address.startsWith('[')) address = address.slice(1, -1); // IPv6
    const port = Number(m[3]);
    if (!(port >= 1 && port <= 65535)) throw new Error('Порт вне диапазона 1–65535');

    const q = new URLSearchParams(m[4] || '');
    const get = (k, d = '') => (q.get(k) ?? d).trim();

    const type = (get('type', 'tcp') || 'tcp').toLowerCase();
    if (!TRANSPORTS.includes(type)) throw new Error(`Транспорт «${type}» не поддерживается`);

    const security = (get('security', 'none') || 'none').toLowerCase();
    if (!['none', 'tls', 'reality'].includes(security)) throw new Error(`security=${security} не поддерживается`);

    const encryption = get('encryption', 'none') || 'none';
    if (encryption !== 'none') throw new Error('VLESS encryption отличное от none пока не поддерживается');

    const p = {
      uuid, address, port,
      name: dec(m[5] || '') || `${address}:${port}`,
      type, security, encryption,
      flow: get('flow'),
      sni: get('sni') || get('peer'),
      fp: get('fp'),
      pbk: get('pbk'),
      sid: get('sid'),
      spx: get('spx'),
      alpn: get('alpn'),
      path: get('path'),
      host: get('host'),
      serviceName: get('serviceName'),
      allowInsecure: ['1', 'true'].includes(get('allowInsecure').toLowerCase()),
    };

    if (security === 'reality') {
      if (!p.pbk) throw new Error('Для Reality обязателен параметр pbk (публичный ключ)');
      if (!p.sni) throw new Error('Для Reality обязателен параметр sni');
      if (!p.fp) p.fp = 'chrome';
      if (p.sid && !/^[0-9a-f]{0,16}$/i.test(p.sid)) throw new Error('sid должен быть hex-строкой до 16 символов');
    }
    if (p.fp && !FINGERPRINTS.includes(p.fp)) throw new Error(`Неизвестный fingerprint: ${p.fp}`);
    if (p.flow && p.flow !== 'xtls-rprx-vision') throw new Error(`flow=${p.flow} не поддерживается (только xtls-rprx-vision)`);
    if (p.flow && p.type !== 'tcp') throw new Error('flow (Vision) работает только с type=tcp');
    if (p.flow && p.security === 'none') throw new Error('flow (Vision) требует TLS или Reality');
    return p;
  }

  /** Находит все vless:// ссылки в произвольном тексте (по одной на строку или через пробел). */
  function extractLinks(text) {
    return (String(text || '').match(/vless:\/\/[^\s"'<>]+/gi) || []);
  }

  /** Строит outbound sing-box из разобранной ссылки. */
  function buildOutbound(p) {
    const ob = {
      type: 'vless',
      tag: 'proxy',
      server: p.address,
      server_port: p.port,
      uuid: p.uuid,
      packet_encoding: 'xudp',
    };
    if (p.flow) ob.flow = p.flow;

    if (p.security === 'tls' || p.security === 'reality') {
      ob.tls = {
        enabled: true,
        server_name: p.sni || (p.type === 'ws' ? p.host : '') || p.address,
      };
      if (p.allowInsecure) ob.tls.insecure = true;
      if (p.alpn) ob.tls.alpn = p.alpn.split(',').map(s => s.trim()).filter(Boolean);
      if (p.fp) ob.tls.utls = { enabled: true, fingerprint: p.fp };
      if (p.security === 'reality') {
        ob.tls.reality = { enabled: true, public_key: p.pbk, short_id: p.sid || '' };
        if (!ob.tls.utls) ob.tls.utls = { enabled: true, fingerprint: 'chrome' };
      }
    }

    switch (p.type) {
      case 'ws':
        ob.transport = { type: 'ws', path: p.path || '/' };
        if (p.host) ob.transport.headers = { Host: p.host };
        break;
      case 'grpc':
        ob.transport = { type: 'grpc', service_name: p.serviceName || p.path || '' };
        break;
      case 'http':
        ob.transport = { type: 'http', path: p.path || '/' };
        if (p.host) ob.transport.host = p.host.split(',').map(s => s.trim());
        break;
      case 'httpupgrade':
        ob.transport = { type: 'httpupgrade', path: p.path || '/' };
        if (p.host) ob.transport.host = p.host;
        break;
      default: /* tcp — без транспорта */ break;
    }
    return ob;
  }

  const isIp = (s) => /^[\d.]+$/.test(s) || s.includes(':');

  /**
   * Генерирует полный конфиг sing-box.
   * @param {object} p        результат parseVless()
   * @param {object} opts     { mode:'tun'|'proxy', proxyPort, dnsRemote, logLevel, bypassLan,
   *                            platform:'windows'|'android'|'web', clashPort, clashSecret }
   */
  function buildSingBoxConfig(p, opts = {}) {
    const o = Object.assign({
      mode: 'tun', proxyPort: 2080, dnsRemote: '1.1.1.1', logLevel: 'info',
      bypassLan: true, platform: 'windows', clashPort: 9090, clashSecret: '',
    }, opts);

    const inbounds = [];
    if (o.mode === 'tun') {
      inbounds.push({
        type: 'tun',
        tag: 'tun-in',
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        mtu: 1500,
        auto_route: true,
        strict_route: true,          // защита от утечек DNS/маршрутов мимо TUN
        stack: o.platform === 'android' ? 'gvisor' : 'mixed',
      });
    } else {
      inbounds.push({
        type: 'mixed',               // SOCKS5 + HTTP на одном порту
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: Number(o.proxyPort),
      });
    }

    const dnsRules = [];
    if (!isIp(p.address)) dnsRules.push({ domain: [p.address], server: 'dns-direct' });

    const routeRules = [
      { action: 'sniff' },
      { protocol: 'dns', action: 'hijack-dns' },
    ];
    if (o.bypassLan) routeRules.push({ ip_is_private: true, outbound: 'direct' });

    return {
      log: { level: o.logLevel, timestamp: true },
      dns: {
        servers: [
          { tag: 'dns-remote', type: 'https', server: o.dnsRemote, detour: 'proxy' },
          { tag: 'dns-direct', type: 'udp', server: '1.1.1.1' }, // только для резолва адреса VPS
        ],
        rules: dnsRules,
        final: 'dns-remote',
        strategy: 'prefer_ipv4',
      },
      inbounds,
      outbounds: [
        buildOutbound(p),
        { type: 'direct', tag: 'direct' },
      ],
      route: {
        rules: routeRules,
        final: 'proxy',
        auto_detect_interface: true,
        default_domain_resolver: 'dns-direct',
      },
      experimental: {
        // Локальный API статистики. Слушает только loopback, защищён секретом.
        clash_api: {
          external_controller: `127.0.0.1:${o.clashPort}`,
          secret: o.clashSecret,
          access_control_allow_origin: ['*'],
        },
      },
    };
  }

  global.NeonVless = { parseVless, extractLinks, buildOutbound, buildSingBoxConfig };
  if (typeof module !== 'undefined') module.exports = global.NeonVless;
})(typeof window !== 'undefined' ? window : globalThis);
