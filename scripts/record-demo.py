"""Record the real hand-driven demo, with monotonic event times and CLI receipts."""
import json
import math
import os
from pathlib import Path
import runpy
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('ORBIT_DEMO_OUTPUT', ROOT / 'temp' / 'demo'))
OUT.mkdir(parents=True, exist_ok=True)
os.environ['ORBIT_DEMO_OUTPUT'] = str(OUT)
helpers = runpy.run_path(str(ROOT / 'scripts' / 'xr-smoke.py'))
call, key, position = (helpers[name] for name in ('call', 'key', 'position'))
call.__globals__['OUT'] = OUT
CLI = ROOT / 'node_modules/.bin/iwsdk'
timeline = {'source': 'Live browser XR emulator; native hand-pinch/select commands; ECS reads only',
            'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'events': [], 'success': False}
capture_zero = None


def mark(name, data=None):
    now = time.monotonic()
    event = {'name': name, 'monotonic_seconds': now,
             'video_seconds': None if capture_zero is None else round(now - capture_zero, 3)}
    if data is not None:
        event['state'] = {field: key(data, field) for field in (
            'selectedCut', 'yawDegrees', 'completedCuts', 'taskStage', 'workPaused',
            'activeShot', 'panoramaVisible', 'correctedReview', 'reviewYawDegrees', 'exportState')}
    timeline['events'].append(event)
    (OUT / 'timeline.json').write_text(json.dumps(timeline, indent=2) + '\n')
    print(json.dumps(event), flush=True)


def named_uuid(data, name):
    if isinstance(data, dict):
        if data.get('name') == name:
            return data.get('uuid')
        for value in data.values():
            found = named_uuid(value, name)
            if found:
                return found
    elif isinstance(data, list):
        for value in data:
            found = named_uuid(value, name)
            if found:
                return found


def capture(action):
    os.environ['ORBIT_RECORD_ACTION'] = action
    return call(f'capture-{action}', 'browser run scripts/record-demo.mjs')


if '--check' in __import__('sys').argv:
    assert named_uuid({'children': [{'name': 'button', 'uuid': 'abc'}]}, 'button') == 'abc'
    assert key({'data': {'completedCuts': 0}}, 'completedCuts') == 0
    print('Recording helper checks passed')
    raise SystemExit(0)

log = (OUT / 'runtime.log').open('w')
proc = subprocess.Popen([str(CLI), 'dev', 'up', '--headless', '--open',
                         '--allow-browser-automation', '--screenshot-width', '1000',
                         '--screenshot-height', '760', '--foreground'],
                        cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
recording = False
try:
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        time.sleep(4)
        status = call('dev-status', 'dev status', required=False)
        if key(status, 'browserCommandReady') is True:
            break
        if proc.poll() is not None:
            raise RuntimeError('Managed runtime exited during startup')
    else:
        raise TimeoutError('Managed runtime startup exceeded 150 seconds')
    deadline = time.monotonic() + 90
    while True:
        status = call('xr-before', 'xr status', {})
        if key(status, 'sessionActive') or key(status, 'sessionOffered'):
            break
        if time.monotonic() > deadline:
            raise TimeoutError('XR session offer missing')
        time.sleep(2)
    if key(status, 'sessionActive') is not True:
        call('xr-enter', 'xr enter', {})
    assert key(call('xr-active', 'xr status', {}), 'sessionActive') is True
    state_id = key(call('state-find', 'ecs find', {'namePattern': '^orbit-cut-state$', 'limit': 2}), 'entityIndex')
    ring_id = key(call('ring-find', 'ecs find', {'namePattern': '^orbit-yaw-ring$', 'limit': 2}), 'entityIndex')
    assert isinstance(state_id, int) and isinstance(ring_id, int)
    hierarchy = call('hierarchy', 'scene runtime-hierarchy', {'maxDepth': 8})
    call('hand-mode', 'xr set-input-mode', {'mode': 'hand'})

    def state(label, timeout=12, **expected):
        deadline = time.monotonic() + timeout
        while True:
            data = call(label, 'ecs query', {'entityIndex': state_id})
            if all(key(data, field) == value for field, value in expected.items()):
                return data
            if time.monotonic() > deadline:
                raise AssertionError(f'{label}: expected {expected}; inspect saved state')
            time.sleep(.2)

    def click(name, label=None):
        label = label or name
        uuid = named_uuid(hierarchy, name)
        assert uuid, f'Native runtime control missing: {name}'
        transform = call(f'{label}-target', 'scene transform', {'uuid': uuid})
        target = key(transform, 'positionRelativeToXROrigin')
        if isinstance(target, list):
            target = dict(zip(('x', 'y', 'z'), target))
        assert target
        call(f'{label}-aim', 'xr look-at', {'device': 'hand-right', 'target': target})
        mark(f'{label}-select-start')
        call(f'{label}-select', 'xr select', {'device': 'hand-right', 'duration': .2})

    def rotate(label, delta):
        center = position(call(f'{label}-ring', 'ecs query', {'entityIndex': ring_id}))
        before = state(f'{label}-before')
        call(f'{label}-aim', 'xr look-at', {'device': 'hand-right', 'target': dict(zip(('x', 'y', 'z'), center))})
        q = key(call(f'{label}-pose', 'xr get-transform', {'device': 'hand-right'}), 'orientation')
        mark(f'{label}-pinch-start', before)
        call(f'{label}-hold', 'xr set-select-value', {'device': 'hand-right', 'value': 1})
        state(f'{label}-held', isDragging=True)
        for step in range(1, 9):
            angle = math.radians(delta * step / 8) / 2
            c, s = math.cos(angle), math.sin(angle)
            call(f'{label}-turn-{step}', 'xr set-transform', {'device': 'hand-right', 'orientation': {
                'x': c*q['x'] + s*q['z'], 'y': c*q['y'] + s*q['w'],
                'z': c*q['z'] - s*q['x'], 'w': c*q['w'] - s*q['y']}})
            time.sleep(.15)
        call(f'{label}-release', 'xr set-select-value', {'device': 'hand-right', 'value': 0})
        final = state(f'{label}-final', isDragging=False)
        assert abs(key(final, 'yawDegrees') - key(before, 'yawDegrees') - delta) < 2
        assert key(final, 'inputKind') == 'hand-pinch'
        mark(f'{label}-aligned', final)
        time.sleep(4)
        return final

    initial = state('initial', mediaReady=True, completedCuts=0, selectedCut=0)
    started = capture('start')
    capture_zero = time.monotonic() + key(started, 'startedEpochMs') / 1000 - time.time()
    timeline['capture'] = key(started, 'result')
    recording = True
    mark('initial-two-window-mismatch', initial)
    time.sleep(4)
    first = rotate('first-cut', -55)
    assert key(first, 'completedCuts') == 1
    call('initial-aligned-image', 'browser screenshot', {}, extra=('--output-file', str(OUT / 'first-aligned.png')))

    click('review-panorama', 'first-review')
    state('review-second-shot', activeShot='shot-2')
    click('review-pause', 'freeze-second-shot')
    frozen = state('review-frozen', activeShot='shot-2', panoramaVisible=True)
    head_before = call('review-head-before', 'xr get-transform', {'device': 'headset'})
    click('review-original')
    original = state('review-original-state', correctedReview=False)
    mark('original-fixed-view', original)
    call('original-image', 'browser screenshot', {}, extra=('--output-file', str(OUT / 'original.png')))
    time.sleep(4)
    click('review-corrected')
    corrected = state('review-corrected-state', correctedReview=True)
    head_after = call('review-head-after', 'xr get-transform', {'device': 'headset'})
    assert key(head_before, 'orientation') == key(head_after, 'orientation')
    assert position(head_before) == position(head_after)
    assert abs(key(corrected, 'reviewYawDegrees') + 55) < 2
    timeline['same_viewpoint'] = True
    mark('corrected-fixed-view', corrected)
    call('corrected-image', 'browser screenshot', {}, extra=('--output-file', str(OUT / 'corrected.png')))
    time.sleep(4)
    click('review-panorama', 'back-to-workbench')
    state('workbench-returned', panoramaVisible=False)
    click('task-next', 'select-second-cut')
    second_initial = state('second-initial', selectedCut=1, completedCuts=1)
    mark('second-cut-before', second_initial)
    time.sleep(3)
    second = rotate('second-cut', 35 - key(second_initial, 'yawDegrees'))
    assert key(second, 'completedCuts') == 2
    click('pause-work')
    paused = state('paused', workPaused=True, completedCuts=2)
    mark('paused-edits-kept', paused)
    time.sleep(4)
    click('task-next', 'continue-work')
    resumed = state('resumed', workPaused=False, completedCuts=2)
    assert abs(key(resumed, 'yawDegrees') - 35) < 2
    mark('continued-edits-kept', resumed)
    time.sleep(4)
    click('task-next', 'final-review')
    state('final-review-state', panoramaVisible=True)
    mark('whole-film-review')
    time.sleep(12)
    click('task-next', 'export-real-mp4')
    mark('export-started')
    ready = state('export-ready', timeout=65, exportState='ready', taskStage='complete')
    mark('export-ready', ready)
    time.sleep(5)
    timeline['actual_export'] = key(capture('save-export'), 'result')
    assert key(call('xr-final', 'xr status', {}), 'sessionActive') is True
    mark('capture-finished')
    capture('stop')
    recording = False
    timeline['success'] = True
except Exception as error:
    timeline['error'] = f'{type(error).__name__}: {error}'
    try:
        call('failure-console', 'browser logs', {'count': 20}, required=False)
    except Exception:
        pass
    raise
finally:
    if recording:
        try:
            capture('stop')
        except Exception as error:
            timeline['capture_stop_error'] = str(error)
    (OUT / 'timeline.json').write_text(json.dumps(timeline, indent=2) + '\n')
    subprocess.run([str(CLI), 'dev', 'down'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=30)
    if proc.poll() is None:
        proc.terminate()
    log.close()
