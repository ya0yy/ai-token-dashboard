"""通过公网 HTTPS 限时采集并上报，由 crontab 每五分钟调用。"""

import argparse
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from zoneinfo import ZoneInfo


DEFAULT_PUSH_URL = 'https://tks.420114.xyz/api/ingest'


def timestamp():
    return datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')


def log(message):
    print(f'[信息] {timestamp()} {message}', flush=True)


def validate_endpoint(value):
    endpoint = urllib.parse.urlsplit(value)
    if (endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username
            or endpoint.password or endpoint.query or endpoint.fragment):
        raise ValueError('上报地址须为完整HTTPS地址，不包含账号密码、查询串或片段。')
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # 令牌只发送给配置的端点，不跟随重定向到其他地址。
        return None


def check_endpoint(settings):
    endpoint = validate_endpoint(settings['pushUrl'])
    token = settings.get('ingestToken')
    if not isinstance(token, str) or not token.strip():
        raise ValueError('缺少采集令牌 ingestToken。')
    request = urllib.request.Request(endpoint, headers={'Authorization': 'Bearer ' + token})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    log(f'检查公网采集端点，方法: GET, 地址: {endpoint}')
    try:
        with opener.open(request, timeout=15) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
    if status == 401:
        raise RuntimeError('采集令牌无效，请使用 ingestToken，而不是网页登录密码。')
    # GET经过采集令牌鉴权后返回404；实际用量写入使用POST。
    if status != 404:
        raise RuntimeError(f'公网端点返回非预期状态: {status}，请核对完整的 /api/ingest 地址。')
    log(f'公网HTTPS连接及采集令牌检查通过，HTTP状态: {status}')


def write_status(root, state):
    descriptor, temporary = tempfile.mkstemp(prefix='.last-run.', suffix='.tmp', dir=root)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump(state, output, ensure_ascii=False, indent=2)
            output.write('\n')
        os.replace(temporary, root / 'last-run.json')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='只检查公网端点和采集令牌')
    mode.add_argument('--scheduled', action='store_true', help='标记为crontab触发的任务')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    settings = json.loads((root / 'client.json').read_text())
    validate_endpoint(settings['pushUrl'])
    if args.check:
        check_endpoint(settings)
        return 0
    node = settings.get('node')
    if not node or not os.access(node, os.X_OK):
        raise RuntimeError('配置中的Node绝对路径不可执行，请检查SDK或重新运行安装器。')

    with (root / '.collector.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log('已有采集任务运行，本轮跳过，避免任务重叠。')
            return 0
        state = {
            'runId': uuid.uuid4().hex[:12], 'pid': os.getpid(),
            'trigger': 'cron' if args.scheduled else 'manual',
            'triggerText': '定时任务' if args.scheduled else '手动执行',
            'device': settings['device'], 'endpoint': settings['pushUrl'],
            'status': 'running', 'statusText': '执行中', 'startedAt': timestamp(),
            'finishedAt': None, 'exitCode': None,
        }
        write_status(root, state)
        log(f"开始采集，任务: {state['runId']}, 来源: {state['triggerText']}, 设备: {state['device']}")
        child = None
        started = time.monotonic()

        def interrupted(signum, frame):
            raise InterruptedError(f'采集收到停止信号: {signum}')

        signal.signal(signal.SIGTERM, interrupted)
        try:
            check_endpoint(settings)
            environment = dict(os.environ)
            environment.pop('AI_TOKEN_PUSH_URL', None)
            environment['NODE_USE_ENV_PROXY'] = '0'
            child = subprocess.Popen([node, str(root / 'collector-entry.mjs')], cwd=root, env=environment)
            try:
                code = child.wait(timeout=900)
            except subprocess.TimeoutExpired:
                raise TimeoutError('采集与推送超过900秒，请检查日志规模、网络和服务端响应后重试。')
            if code:
                raise RuntimeError(f'采集器退出码: {code}，请查看前面的采集或HTTP错误。')
            state.update(status='ok', statusText='成功', finishedAt=timestamp(), exitCode=0)
            write_status(root, state)
            log(f"本轮采集与公网推送完成，任务: {state['runId']}, 耗时: {time.monotonic() - started:.1f}秒")
            return 0
        except BaseException:
            state.update(status='error', statusText='失败', finishedAt=timestamp(), exitCode=1)
            write_status(root, state)
            raise
        finally:
            stop_process(child)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('[错误] 采集未完成，下一轮会重试；请按错误详情检查公网地址、令牌和网络。', file=sys.stderr, flush=True)
        traceback.print_exc()
        sys.exit(1)
