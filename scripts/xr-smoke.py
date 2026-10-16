"""One unchanged starter-scene XR interaction, with explicit saved evidence."""
import json
import math
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp'
CLI = ROOT / 'node_modules/.bin/iwsdk'
OUT.mkdir(exist_ok=True)
os.environ.setdefault('TMPDIR', str(OUT))


def key(data, name):
    if isinstance(data, dict):
        if name in data:
            return data[name]
        for value in data.values():
            found = key(value, name)
            if found is not None:
                return found
    elif isinstance(data, list):
        for value in data:
            found = key(value, name)
            if found is not None:
                return found
    return None


def call(label, command, params=None, extra=(), required=True):
    args = [str(CLI), *command.split(), '--timeout', '60000']
    if params is not None:
        args += ['--input-json', json.dumps(params)]
    args += list(extra)
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=70)
    (OUT / f'{label}.json').write_text(result.stdout)
    if result.stderr:
        (OUT / f'{label}.stderr.log').write_text(result.stderr)
    try:
        data = json.loads(result.stdout or result.stderr)
    except json.JSONDecodeError:
        raise RuntimeError(f'{label}: non-JSON CLI output; see saved receipt')
    if required and (result.returncode or data.get('ok') is False):
        raise RuntimeError(f'{label}: command failed; see saved receipt')
    print(label, result.returncode, flush=True)
    return data


def position(data):
    p = key(data, 'worldPosition')
    if p is None:
        p = key(data, 'position')
    if isinstance(p, list) and len(p) == 3:
        return p
    if isinstance(p, dict) and all(k in p for k in ('x', 'y', 'z')):
        return [p[k] for k in ('x', 'y', 'z')]
    raise RuntimeError('Position absent from saved state; inspect the actual response schema')


if __name__ == '__main__':
    # The only parsing helper is checked locally without starting a browser.
    assert key({'data': {'sessionActive': False}}, 'sessionActive') is False
    assert position({'data': {'position': {'x': 1, 'y': 2, 'z': 3}}}) == [1, 2, 3]
    if '--check' in __import__('sys').argv:
        print('Receipt parsing checks passed')
        raise SystemExit(0)
    receipt = {'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'runtime_gate_passed': False, 'scene': 'unchanged IWSDK starter',
               'rendering': 'headless SwiftShader; browser XR emulator',
               'host_meminfo': Path('/proc/meminfo').read_text().splitlines()[:3]}
    log = (OUT / 'runtime.log').open('w')
    proc = subprocess.Popen([str(CLI), 'dev', 'up', '--headless', '--open',
                             '--screenshot-width', '800', '--screenshot-height', '600', '--foreground'],
                            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            time.sleep(5)
            state = call('dev-status', 'dev status', required=False)
            if key(state, 'browserCommandReady') is True:
                break
            if proc.poll() is not None:
                raise RuntimeError('Dev process exited before runtime readiness')
        else:
            raise TimeoutError('Runtime readiness exceeded 150 seconds')

        # A command bridge appears before World.create finishes loading assets.
        # Wait for the application's actual session offer, not transport alone.
        deadline = time.monotonic() + 90
        while True:
            status = call('xr-before', 'xr status', {})
            if key(status, 'sessionActive') is True or key(status, 'sessionOffered') is True:
                break
            if time.monotonic() >= deadline:
                raise TimeoutError('Application did not offer XR within 90 seconds')
            time.sleep(3)
        if key(status, 'sessionActive') is not True:
            call('xr-enter', 'xr enter', {})
        status = call('xr-active', 'xr status', {})
        assert key(status, 'sessionActive') is True, 'XR session did not activate'

        found = call('plant-find', 'ecs find', {'namePattern': '^Plant Sansevieria$', 'limit': 5})
        entity = key(found, 'entityIndex')
        assert isinstance(entity, int), 'Named plant entity missing'
        before = call('plant-before', 'ecs query', {'entityIndex': entity})
        assert 'DistanceGrabbable' in json.dumps(before), 'Wrong interaction contract'
        start = position(before)
        controller = position(call('controller-before', 'xr get-transform', {'device': 'controller-right'}))
        distance = math.dist(start, controller)
        destination = dict(zip(('x', 'y', 'z'), [start[0] - .5, start[1] + .25, start[2]]))
        call('aim', 'xr look-at', {'device': 'controller-right', 'target': dict(zip(('x', 'y', 'z'), start))})
        call('hold', 'xr set-gamepad-state', {'device': 'controller-right', 'buttons': [{'index': 0, 'value': 1}]})
        time.sleep(.5)
        call('plant-held', 'ecs query', {'entityIndex': entity})
        call('move', 'xr look-at', {'device': 'controller-right', 'target': destination, 'moveToDistance': distance})
        time.sleep(.5)
        moved = call('plant-moved', 'ecs query', {'entityIndex': entity})
        call('release', 'xr set-gamepad-state', {'device': 'controller-right', 'buttons': [{'index': 0, 'value': 0}]})
        time.sleep(.5)
        final = call('plant-final', 'ecs query', {'entityIndex': entity})
        end = position(final)
        assert math.dist(start, end) > .2, 'Real controller input did not move the plant'
        assert math.dist(position(moved), end) < .1, 'Released plant failed to keep its moved position'
        assert key(call('xr-final', 'xr status', {}), 'sessionActive') is True
        call('runtime-image', 'browser screenshot', {}, extra=('--output-file', str(OUT / 'xr-final.png')))
        receipt.update(runtime_gate_passed=True, entity_index=entity, initial_position=start,
                       final_position=end, moved_metres=math.dist(start, end))
    except Exception as error:
        receipt['error'] = f'{type(error).__name__}: {error}'
        try:
            call('console-on-failure', 'browser logs', {'count': 20}, required=False)
        except Exception:
            pass
        raise
    finally:
        receipt['finished_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        (OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        subprocess.run([str(CLI), 'dev', 'down'], cwd=ROOT, stdout=log,
                       stderr=subprocess.STDOUT, timeout=30)
        if proc.poll() is None:
            proc.terminate()
        log.close()
