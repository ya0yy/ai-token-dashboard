"""安装或更新 crontab 客户端，保留本机历史数据并直接通过公网 HTTPS 上报。"""

import argparse
from datetime import datetime
import fcntl
import getpass
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import traceback
import uuid

from run import DEFAULT_PUSH_URL, check_endpoint, log, validate_endpoint


BEGIN = '# BEGIN AI_TOKEN_DASHBOARD'
END = '# END AI_TOKEN_DASHBOARD'
DIRECTORIES = ('src', 'db', 'config', 'patches')
FILES = ('package.json', 'LICENSE', 'SOURCE_COMMIT', 'collector-entry.mjs',
         'collector-entry-manual.mjs', 'run.py', 'client.json')


def command(arguments, timeout=30, **kwargs):
    try:
        return subprocess.run(arguments, timeout=timeout, check=True, **kwargs)
    except subprocess.CalledProcessError as error:
        if error.stderr:
            print('[错误] 命令返回详情: ' + str(error.stderr).strip(), file=sys.stderr, flush=True)
        raise


def read_crontab(binary):
    result = subprocess.run([binary, '-l'], capture_output=True, text=True,
                            env={**os.environ, 'LC_ALL': 'C'}, timeout=15)
    if result.returncode == 0:
        return result.stdout
    if result.returncode == 1 and 'no crontab' in result.stderr.lower():
        return ''
    raise RuntimeError('读取当前用户crontab失败: ' + result.stderr.strip())


def split_managed(text):
    lines = text.splitlines(keepends=True)
    begin = [i for i, line in enumerate(lines) if line.strip() == BEGIN]
    end = [i for i, line in enumerate(lines) if line.strip() == END]
    if not begin and not end:
        return text, ''
    if len(begin) != 1 or len(end) != 1 or begin[0] >= end[0]:
        raise RuntimeError('应用cron标记不完整或重复，请先核对crontab；没有修改其他任务。')
    start, stop = begin[0], end[0] + 1
    return ''.join(lines[:start] + lines[stop:]), ''.join(lines[start:stop])


def merge_crontab(current, block):
    remaining, _ = split_managed(current)
    if not block:
        return remaining
    return remaining.rstrip('\n') + ('\n\n' if remaining.strip() else '') + block.rstrip('\n') + '\n'


def write_crontab(binary, content):
    descriptor, name = tempfile.mkstemp(prefix='ai-token-crontab-', suffix='.txt')
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(content)
        try:
            command([binary, name], capture_output=True, text=True, timeout=15)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError('写入crontab超过15秒。macOS请核对当前终端应用的完全磁盘访问权限，或在系统终端中运行安装器；旧任务将保留。') from error
    finally:
        os.unlink(name)


def cron_block(python, runtime, logs):
    arguments = [str(python), str(runtime / 'run.py'), '--scheduled']
    action = shlex.join(arguments) + ' >> ' + shlex.quote(str(logs / 'collector.out.log'))
    action += ' 2>> ' + shlex.quote(str(logs / 'collector.err.log'))
    # cron在引号内也解释百分号，绝对路径中的百分号需要额外转义。
    action = action.replace('%', r'\%')
    return f'{BEGIN}\n*/5 * * * * {action}\n{END}\n'


def private_write(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix='.install.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def probe(arguments):
    return subprocess.run(arguments, capture_output=True, text=True, timeout=15)


def legacy_services(system, home):
    entries = []
    if system == 'Darwin':
        for suffix in ('collector', 'tunnel'):
            name = 'com.yaoyang.ai-token-dashboard.' + suffix
            path = home / 'Library/LaunchAgents' / (name + '.plist')
            target = f'gui/{os.getuid()}/{name}'
            loaded = probe(['launchctl', 'print', target]).returncode == 0
            if loaded and not path.exists():
                raise RuntimeError('旧任务已加载但配置文件缺失，无法备份: ' + str(path))
            if path.exists():
                entries.append({'kind': 'launchd', 'name': target, 'path': path,
                                'data': path.read_bytes(), 'active': loaded, 'enabled': loaded})
    else:
        root = home / '.config/systemd/user'
        names = ('ai-token-dashboard-collector.timer', 'ai-token-dashboard-collector.service',
                 'ai-token-dashboard-tunnel.service')
        paths = [root / name for name in names if (root / name).exists()]
        if paths and not shutil.which('systemctl'):
            raise RuntimeError('发现旧应用systemd配置但没有systemctl，请先停用旧任务后再迁移。')
        for path in paths:
            active = probe(['systemctl', '--user', 'is-active', path.name]).stdout.strip()
            enabled = probe(['systemctl', '--user', 'is-enabled', path.name]).stdout.strip() == 'enabled'
            entries.append({'kind': 'systemd', 'name': path.name, 'path': path,
                            'data': path.read_bytes(), 'active': active in ('active', 'activating'),
                            'enabled': enabled})
    return entries


def wait_legacy_collector(entry):
    deadline = time.monotonic() + 930
    announced = False
    while True:
        if entry['kind'] == 'launchd':
            result = probe(['launchctl', 'print', entry['name']])
            match = re.search(r'^\s*state = (.+)$', result.stdout, re.M)
            busy = result.returncode == 0 and match and match[1] != 'not running'
        else:
            state = probe(['systemctl', '--user', 'show', '-p', 'ActiveState', '--value',
                           entry['name']]).stdout.strip()
            busy = state in ('active', 'activating')
        if not busy:
            return
        if not announced:
            log('旧采集任务尚未完成，等待其退出后迁移，最长930秒。')
            announced = True
        if time.monotonic() >= deadline:
            raise TimeoutError('旧采集任务未在930秒内结束，已停止本次迁移。')
        time.sleep(2)


def retire_legacy(entries):
    # 先停止Linux定时器，再等待已有采集结束，最后停用隧道。
    ordered = sorted(entries, key=lambda item: (
        0 if item['name'].endswith('.timer') else
        2 if 'tunnel' in item['name'] else 1))
    for entry in ordered:
        if 'collector' in entry['name'] and not entry['name'].endswith('.timer') and entry['active']:
            wait_legacy_collector(entry)
        if entry['kind'] == 'launchd':
            if entry['active']:
                command(['launchctl', 'bootout', entry['name']], capture_output=True)
        else:
            if entry['enabled']:
                command(['systemctl', '--user', 'disable', '--now', entry['name']], capture_output=True)
            else:
                command(['systemctl', '--user', 'stop', entry['name']], capture_output=True)
        entry['path'].unlink()
        log('旧定时任务或隧道已停用并归档，配置: ' + str(entry['path']))


def restore_legacy(entries):
    for entry in entries:
        entry['path'].parent.mkdir(parents=True, exist_ok=True)
        entry['path'].write_bytes(entry['data'])
    if entries and entries[0]['kind'] == 'systemd':
        command(['systemctl', '--user', 'daemon-reload'], capture_output=True)
    # 隧道先恢复，避免旧采集器启动时没有可用通道。
    for entry in sorted(entries, key=lambda item: 0 if 'tunnel' in item['name'] else 1):
        if entry['kind'] == 'launchd':
            if entry['active'] and probe(['launchctl', 'print', entry['name']]).returncode != 0:
                command(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(entry['path'])], capture_output=True)
        else:
            if entry['enabled']:
                command(['systemctl', '--user', 'enable', entry['name']], capture_output=True)
            if entry['active']:
                command(['systemctl', '--user', 'start', '--no-block', entry['name']], capture_output=True)


def wait_run_lock(lock):
    deadline = time.monotonic() + 930
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise TimeoutError('现有采集进程仍持有锁，迁移等待超过930秒。')
            time.sleep(1)


def backup_database(runtime, backup):
    source = runtime / 'data/usage.sqlite'
    if not source.exists():
        return
    target = backup / 'usage.sqlite'
    deadline = time.monotonic() + 60

    def progress(status, remaining, total):
        if time.monotonic() >= deadline:
            raise TimeoutError('数据库备份超过60秒，安装已停止。')

    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=10) as reader:
        with sqlite3.connect(target) as writer:
            reader.backup(writer, pages=256, progress=progress, sleep=0.05)
    target.chmod(0o600)
    log('现有SQLite及同步进度已备份，文件: ' + str(target))


def snapshot_code(runtime, backup):
    stored = set()
    for name in DIRECTORIES + FILES:
        path = runtime / name
        if not path.exists():
            continue
        stored.add(name)
        target = backup / 'runtime' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if path.is_dir():
            shutil.copytree(path, target)
        else:
            shutil.copy2(path, target)
    return stored


def restore_code(runtime, backup, stored):
    for name in DIRECTORIES + FILES:
        source = backup / 'runtime' / name
        target = runtime / name
        if name in stored:
            if source.is_dir():
                shutil.copytree(source, target, dirs_exist_ok=True)
            else:
                shutil.copy2(source, target)
        elif name in FILES and target.exists():
            target.unlink()
    # 保留迁移期间已采集的新数据，不用旧数据库覆盖它。


def copy_code(source, runtime):
    for name in DIRECTORIES:
        ignored = shutil.ignore_patterns('client', '__pycache__') if name == 'src' else None
        shutil.copytree(source / name, runtime / name, dirs_exist_ok=True, ignore=ignored)
    (runtime / 'data').mkdir(exist_ok=True)
    for name in ('pricing-litellm.json', 'pricing-openrouter.json'):
        target = runtime / 'data' / name
        if not target.exists():
            shutil.copy2(source / 'data' / name, target)
    for name in FILES:
        if name != 'client.json':
            shutil.copy2(source / name, runtime / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', help='新设备须设置唯一名称；重装自动沿用原设备名')
    parser.add_argument('--push-url', help='公网HTTPS完整上报地址，默认 ' + DEFAULT_PUSH_URL)
    args = parser.parse_args()
    system = platform.system()
    if system not in ('Darwin', 'Linux'):
        raise RuntimeError('此安装器支持macOS和Linux。')
    home = Path.home()
    source = Path(__file__).resolve().parent
    runtime = home / ('Library/Application Support/ai-token-dashboard' if system == 'Darwin'
                      else '.local/share/ai-token-dashboard')
    if source == runtime.resolve() or runtime.resolve() in source.parents:
        raise RuntimeError('请从源码目录或解压后的安装包运行安装器，不要在目标运行目录内重装。')
    cron = shutil.which('crontab')
    node = shutil.which('node')
    if not cron or not node:
        raise RuntimeError('需要当前用户可用的crontab和Node.js 22.15以上版本。')
    metadata = json.loads(command([node, '-e',
        'console.log(JSON.stringify({version:process.versions.node,path:process.execPath}))'],
        capture_output=True, text=True).stdout)
    match = re.match(r'(\d+)\.(\d+)\.(\d+)', metadata['version'])
    if not match or tuple(map(int, match.groups())) < (22, 15, 0):
        raise RuntimeError('Node版本过低，需要22.15.0以上。')
    command([metadata['path'], '-e', "require('node:sqlite')"], capture_output=True)
    legacy = home / '.config/ai-token-dashboard/collector.json'
    config_path = runtime / 'client.json'
    previous = {}
    if config_path.exists():
        previous = json.loads(config_path.read_text())
    elif runtime.exists() and legacy.exists():
        previous = json.loads(legacy.read_text())
    if args.device and previous.get('device') and args.device != previous['device']:
        raise RuntimeError('重装须沿用原设备名，避免把相同历史识别为另一台设备。')
    device = previous.get('device') or args.device
    if not isinstance(device, str) or not device.strip() or len(device) > 255 or '\0' in device:
        raise RuntimeError('新设备请用 --device 指定1至255字符的唯一名称。')
    token = previous.get('ingestToken') or getpass.getpass('采集令牌 ingestToken（不回显）: ').strip()
    existing_endpoint = previous.get('pushUrl', '')
    endpoint = args.push_url or (existing_endpoint if existing_endpoint.startswith('https://') else DEFAULT_PUSH_URL)
    settings = {'device': device, 'ingestToken': token, 'pushUrl': validate_endpoint(endpoint),
                'timezone': previous.get('timezone', 'Asia/Shanghai'), 'node': metadata['path']}
    # 先核对公网连接和令牌，再停用旧任务。
    check_endpoint(settings)
    python = Path(os.path.abspath(sys.executable))
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    runtime.chmod(0o700)
    with (runtime / '.install.lock').open('a') as install_lock:
        try:
            fcntl.flock(install_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('已有安装进程，请等待其完成。')
        before_cron = read_crontab(cron)
        _, previous_block = split_managed(before_cron)
        # 先确认系统允许写入，再停旧任务，避免macOS隐私权限导致迁移中断。
        log('预检crontab写入权限，现有任务内容保持一致。')
        write_crontab(cron, before_cron)
        other, _ = split_managed(before_cron)
        if any('ai-token-dashboard' in line and not line.lstrip().startswith('#')
               and any(name in line for name in ('run.py', 'collect-once', 'src/collect.mjs'))
               for line in other.splitlines()):
            raise RuntimeError('发现未托管的旧采集cron任务，请先核对并移除，避免重复调度。')
        entries = legacy_services(system, home)
        backup = runtime / 'backups' / ('cron-migration-' + datetime.now().strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:6])
        backup.mkdir(parents=True, mode=0o700)
        private_write(backup / 'crontab-before.txt', before_cron)
        (backup / 'legacy').mkdir()
        for entry in entries:
            (backup / 'legacy' / entry['path'].name).write_bytes(entry['data'])
        legacy_bytes = legacy.read_bytes() if legacy.exists() else None
        if legacy_bytes is not None:
            (backup / 'legacy-config.json').write_bytes(legacy_bytes)
            (backup / 'legacy-config.json').chmod(0o600)
        stored = None
        paused = False
        code_changed = False
        try:
            if previous_block:
                write_crontab(cron, merge_crontab(read_crontab(cron), ''))
            paused = True
            retire_legacy(entries)
            with (runtime / '.collector.lock').open('a') as run_lock:
                wait_run_lock(run_lock)
                backup_database(runtime, backup)
                stored = snapshot_code(runtime, backup)
                code_changed = True
                copy_code(source, runtime)
                private_write(config_path, json.dumps(settings, ensure_ascii=False, indent=2) + '\n')
                fcntl.flock(run_lock, fcntl.LOCK_UN)
            logs = runtime / 'logs'
            logs.mkdir(exist_ok=True, mode=0o700)
            logs.chmod(0o700)
            for name in ('collector.out.log', 'collector.err.log'):
                (logs / name).touch(mode=0o600, exist_ok=True)
            log('开始首次公网采集与历史核对，最长15分钟；现有数据库与设备名已保留。')
            command([str(python), str(runtime / 'run.py')], timeout=960)
            block = cron_block(python, runtime, logs)
            write_crontab(cron, merge_crontab(read_crontab(cron), block))
            if legacy_bytes is not None:
                old = json.loads(legacy_bytes)
                old['pushUrl'] = endpoint
                private_write(legacy, json.dumps(old, ensure_ascii=False, indent=2) + '\n')
            log(f'crontab安装完成，周期: 5分钟, 设备: {device}, 公网上报地址: {endpoint}')
            log('配置文件: ' + str(config_path))
            log('日志目录: ' + str(logs))
            log('重装备份目录: ' + str(backup))
        except BaseException:
            print('[错误] 安装失败，正在恢复原调度与代码；保留最新用量数据库。', file=sys.stderr, flush=True)
            try:
                if code_changed and stored is not None:
                    restore_code(runtime, backup, stored)
                if legacy_bytes is not None:
                    private_write(legacy, legacy_bytes.decode())
                if paused:
                    try:
                        write_crontab(cron, merge_crontab(read_crontab(cron), previous_block))
                    finally:
                        # cron写入失败时仍恢复旧任务，避免两项恢复相互阻塞。
                        restore_legacy(entries)
            except Exception:
                print('[错误] 自动恢复未完全成功，请按备份目录核对旧配置: ' + str(backup), file=sys.stderr)
                traceback.print_exc()
            raise


if __name__ == '__main__':
    os.umask(0o077)
    def interrupted(signum, frame):
        raise InterruptedError(f'安装收到停止信号: {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except Exception:
        print('[错误] 安装未完成，请按堆栈检查cron权限、SDK、公网地址和令牌。', file=sys.stderr, flush=True)
        traceback.print_exc()
        sys.exit(1)
