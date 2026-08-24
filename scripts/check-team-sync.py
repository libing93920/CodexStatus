# -*- coding: utf-8 -*-
"""CodexStatus 团队同步一键健康诊断
用法: python check-team-sync.py
判定: 全部 [OK] = 同步健康;任一 [FAIL] = 按提示定位
"""
import socket, struct, time, re, subprocess, sys, os

sys.stdout.reconfigure(encoding='utf-8')
MCAST_GRP, MCAST_PORT = '224.0.0.251', 5353
VIRTUAL_PREFIXES = ('172.', '169.254.', '100.64.', '100.65.')

def is_virtual(ip):
    p = ip.split('.')
    if len(p) != 4:
        return True
    a, b, c = int(p[0]), int(p[1]), int(p[2])
    return (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168 and 56 <= c <= 100) \
        or (a == 10 and b == 0 and c == 2) or a == 169 or (a == 100 and 64 <= b <= 127)

def get_local_ips():
    # 用 ipconfig 枚举(Windows 内置,无第三方依赖)
    out = subprocess.run(['ipconfig'], capture_output=True, text=True, encoding='gbk', errors='replace').stdout
    ips = re.findall(r'IPv4[^:]*:\s*(\d+\.\d+\.\d+\.\d+)', out)
    return [i for i in ips if not i.startswith('127.')]

results = []
real_ips = [i for i in get_local_ips() if not is_virtual(i)]
virtual_ips = [i for i in get_local_ips() if is_virtual(i)]

# ── 检查1: 存在真实网卡 IP ──
if real_ips:
    results.append(('OK', f'真实网卡 IP: {", ".join(real_ips)}'))
else:
    results.append(('FAIL', '未找到真实网卡 IP(全是虚拟网卡?)——无法进行局域网同步'))

# ── 检查2: mDNS 响应源必须来自真实网卡(核心回归点) ──
# 注:若 CodexStatus 正占用 5353 端口(绑定具体网卡 IP),本探测可能收不到其响应,
# 此时降级为 WARN——同步健康以检查3(实际连接数)为准
src_ok, src_ip, peer_count = False, None, 0
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(('0.0.0.0', MCAST_PORT))
    except OSError:
        s.bind(('0.0.0.0', 0))
    for lip in set(real_ips + ['0.0.0.0']):
        try:
            s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                         socket.inet_aton(MCAST_GRP) + socket.inet_aton(lip))
        except OSError:
            pass
    header = struct.pack('>HHHHHH', 0, 0, 1, 0, 0, 0)
    qname = b''
    for part in '_codex-status._tcp.local'.split('.'):
        qname += bytes([len(part)]) + part.encode()
    query = header + qname + b'\x00' + struct.pack('>HH', 12, 1)
    for _ in range(4):
        s.sendto(query, (MCAST_GRP, MCAST_PORT))
        time.sleep(0.7)
    s.settimeout(0.4)
    deadline = time.time() + 4
    peers = set()
    sources = set()
    while time.time() < deadline:
        try:
            data, addr = s.recvfrom(8192)
        except (socket.timeout, OSError):
            continue
        text = data.decode('latin1', errors='replace')
        ids = re.findall(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\._codex-status', text)
        if ids:
            sources.add(addr[0])
            peers.update(ids)
    s.close()
    peer_count = len(peers)
    bad_srcs = [x for x in sources if is_virtual(x)]
    src_ip = ', '.join(sources) if sources else '无'
    if sources and not bad_srcs:
        src_ok = True
except Exception as e:
    src_ip = f'探测异常 {e}'

if src_ok:
    results.append(('OK', f'mDNS 服务来源均为真实网卡: {src_ip}(共发现 {peer_count} 个同网段 CodexStatus)'))
elif sources:
    results.append(('FAIL', f'mDNS 响应含虚拟网卡来源({bad_srcs})——广播可能被 NAT 隔离,同事将看不到你!'))
elif peer_count == 0:
    results.append(('WARN', f'mDNS 探测未收到广播(可能与运行中的 CodexStatus 存在端口竞争,或网络隔离)'
                            f'——以最后的连接数检查为准'))

# ── 检查3: CodexStatus 进程与对局域网的 ESTABLISHED 连接数 ──
try:
    out = subprocess.run(['netstat', '-ano', '-p', 'tcp'], capture_output=True,
                         text=True, encoding='gbk', errors='replace').stdout or ''
    tasklist = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq CodexStatus.exe', '/FO', 'CSV', '/NH'],
                              capture_output=True, text=True, encoding='gbk', errors='replace').stdout or ''
    codex_pids = []
    for line in tasklist.splitlines():
        if not line.strip() or 'INFO:' in line.upper():
            continue
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) > 1 and parts[0].startswith('CodexStatus'):
            codex_pids.append(parts[1])
    if not codex_pids:
        results.append(('FAIL', 'CodexStatus 未运行——启动它再测'))
    else:
        conns = {}
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[3] == 'ESTABLISHED' and parts[2].startswith('10.'):
                pid = parts[4]
                if pid in codex_pids:
                    remote_ip = parts[2].rsplit(':', 1)[0]
                    conns.setdefault(remote_ip, 0)
                    conns[remote_ip] += 1
        n_peers = len(conns)
        n_links = sum(conns.values())
        if n_peers >= 3:
            results.append(('OK', f'已连接 {n_peers} 个局域网成员({n_links} 条链路)——同步正常'))
        elif n_peers > 0:
            results.append(('WARN', f'仅连接 {n_peers} 个局域网成员——若预期更多,可能是部分同事离线或跨网段不可达'))
        else:
            results.append(('FAIL', 'CodexStatus 在运行但没有任何局域网连接——团队同步失效!'))
except Exception as e:
    results.append(('WARN', f'连接检查异常: {e}'))

print('=' * 60)
print('CodexStatus 团队同步健康诊断')
print('=' * 60)
for status, msg in results:
    mark = {'OK': '[OK]  ', 'WARN': '[WARN]', 'FAIL': '[FAIL]'}[status]
    print(f'{mark} {msg}')
print('=' * 60)
fails = sum(1 for s, _ in results if s == 'FAIL')
print(f'结论: {"✓ 健康" if fails == 0 else "✗ 存在 " + str(fails) + " 个问题"}')
sys.exit(1 if fails else 0)
