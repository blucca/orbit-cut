"""Orbit Cut: real media, emulated controller and hand-pinch yaw interaction."""
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
               'runtime_gate_passed': False, 'scene': 'Orbit Cut optical workbench',
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

        state_id = key(call('state-find', 'ecs find', {'namePattern': '^orbit-cut-state$', 'limit': 2}), 'entityIndex')
        ring_id = key(call('ring-find', 'ecs find', {'namePattern': '^orbit-yaw-ring$', 'limit': 2}), 'entityIndex')
        panel_id = key(call('panel-find', 'ecs find', {'namePattern': '^workbench-panel$', 'limit': 2}), 'entityIndex')
        assert all(isinstance(v, int) for v in [state_id, ring_id, panel_id]), 'Named workbench entities missing'
        deadline = time.monotonic() + 30
        while True:
            initial = call('state-initial', 'ecs query', {'entityIndex': state_id})
            if key(initial, 'mediaReady') is True:
                break
            if time.monotonic() >= deadline:
                raise TimeoutError('Demo MP4 failed to become ready')
            time.sleep(1)
        assert abs(key(initial, 'yawDegrees')) < .1
        assert key(initial, 'grabCount') == 0
        call('ui-assets', 'ui assets', {})
        call('ui-preview', 'ui render-preview', {'assetId': 'workbench-panel', 'width': 640, 'height': 360},
             extra=('--output-file', str(OUT / 'ui-preview.png')))
        scene = call('scene-hero', 'scene render-file', {'path': 'public/scenes/main.iwsdk.scene.json', 'viewId': 'hero'},
                     extra=('--output-file', str(OUT / 'scene-hero.png')))
        assert key(scene, 'valid') is True, 'Scene validation failed'
        call('scene-state', 'scene state', {})
        call('ui-initial', 'ui inspect', {'entityIndex': panel_id})
        call('runtime-before', 'browser screenshot', {}, extra=('--output-file', str(OUT / 'xr-before.png')))
        interactions = []
        for device, delta in [('controller-right', -25), ('hand-right', -30)]:
            mode = 'hand' if device.startswith('hand') else 'controller'
            if mode == 'hand':
                call('hand-mode', 'xr set-input-mode', {'mode': 'hand'})
                time.sleep(.4)
            ring = call(f'{mode}-ring-before', 'ecs query', {'entityIndex': ring_id})
            center = position(ring)
            state_before = call(f'{mode}-state-before', 'ecs query', {'entityIndex': state_id})
            yaw_before = key(state_before, 'yawDegrees')
            call(f'{mode}-aim', 'xr look-at', {'device': device, 'target': dict(zip(('x', 'y', 'z'), center))})
            pose = call(f'{mode}-pose', 'xr get-transform', {'device': device})
            euler = key(pose, 'euler')
            assert isinstance(euler, dict), 'Measured input pose missing'
            call(f'{mode}-hold', 'xr set-select-value', {'device': device, 'value': 1})
            time.sleep(.4)
            held = call(f'{mode}-held', 'ecs query', {'entityIndex': state_id})
            assert key(held, 'isDragging') is True, f'{mode} failed to grab through native input'
            call(f'{mode}-rotate', 'xr set-transform', {'device': device, 'orientation': {
                'pitch': euler['pitch'], 'yaw': euler['yaw'] + delta, 'roll': euler['roll']}})
            time.sleep(.4)
            moved = call(f'{mode}-moved', 'ecs query', {'entityIndex': state_id})
            call(f'{mode}-release', 'xr set-select-value', {'device': device, 'value': 0})
            time.sleep(.4)
            final = call(f'{mode}-final', 'ecs query', {'entityIndex': state_id})
            yaw = key(final, 'yawDegrees')
            assert abs(yaw - yaw_before) > 10, f'{mode} failed to change the image yaw'
            assert abs(yaw - key(moved, 'yawDegrees')) < 1, 'Released correction did not hold'
            assert key(final, 'isDragging') is False, 'Native grab did not release'
            assert abs(key(final, 'previewYawDegrees') - yaw) < .2, 'Video preview did not use the edited yaw'
            if mode == 'hand':
                assert key(final, 'inputKind') == 'hand-pinch', 'Hand source was not observed'
            interactions.append({'input': mode, 'initial_yaw': yaw_before, 'final_yaw': yaw,
                                 'held': True, 'released': True, 'preview_yaw': key(final, 'previewYawDegrees')})
        call('ui-final', 'ui inspect', {'entityIndex': panel_id})
        call('runtime-hierarchy', 'scene runtime-hierarchy', {'maxDepth': 8})
        assert key(call('xr-final', 'xr status', {}), 'sessionActive') is True
        call('runtime-image', 'browser screenshot', {}, extra=('--output-file', str(OUT / 'xr-final.png')))
        call('console-final', 'browser logs', {'count': 30})
        receipt.update(runtime_gate_passed=True, media_ready=True, state_entity=state_id,
                       interactions=interactions, final_yaw=key(final, 'yawDegrees'),
                       aligned=key(final, 'aligned'), scope='Emulated hand/controller input; no physical Quest performance claim')
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
