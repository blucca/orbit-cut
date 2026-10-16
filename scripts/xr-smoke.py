"""Orbit Cut: two-cut native input, fixed-viewpoint panorama, and MP4 export."""
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
            if 'Failed to load level' in (OUT / 'runtime.log').read_text()[-12000:]:
                raise RuntimeError('Scene loading failed; see runtime.log and console-on-failure')
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
        assert key(initial, 'selectedCut') == 0 and key(initial, 'totalCuts') == 2
        assert abs(key(initial, 'cutSeconds') - 4) < .01
        call('ui-assets', 'ui assets', {})
        call('ui-preview', 'ui render-preview', {'assetId': 'workbench-panel', 'width': 640, 'height': 360},
             extra=('--output-file', str(OUT / 'ui-preview.png')))
        scene = call('scene-hero', 'scene render-file', {'path': 'public/scenes/main.iwsdk.scene.json', 'viewId': 'hero', 'width': 512, 'height': 512},
                     extra=('--output-file', str(OUT / 'scene-hero.png')))
        assert key(scene, 'valid') is True, 'Scene validation failed'
        assert {'optical-frame', 'orbit-yaw-ring', 'workbench-panel'} <= set(key(scene, 'visibleNodeIds') or []), 'A preserved workbench part is absent from the authored scene'
        call('scene-state', 'scene state', {})
        call('ui-initial', 'ui inspect', {'entityIndex': panel_id})
        interactions = []
        def rotate(label, device, delta):
            mode = 'hand' if device.startswith('hand') else 'controller'
            ring = call(f'{label}-ring-before', 'ecs query', {'entityIndex': ring_id})
            center = position(ring)
            state_before = call(f'{label}-state-before', 'ecs query', {'entityIndex': state_id})
            yaw_before = key(state_before, 'yawDegrees')
            call(f'{label}-aim', 'xr look-at', {'device': device, 'target': dict(zip(('x', 'y', 'z'), center))})
            pose = call(f'{label}-pose', 'xr get-transform', {'device': device})
            q = key(pose, 'orientation')
            assert isinstance(q, dict), 'Measured input pose missing'
            call(f'{label}-hold', 'xr set-select-value', {'device': device, 'value': 1})
            time.sleep(.4)
            held = call(f'{label}-held', 'ecs query', {'entityIndex': state_id})
            assert key(held, 'isDragging') is True, f'{mode} failed to grab through native input'
            c, s = math.cos(math.radians(delta) / 2), math.sin(math.radians(delta) / 2)
            call(f'{label}-rotate', 'xr set-transform', {'device': device, 'orientation': {
                'x': c*q['x'] + s*q['z'], 'y': c*q['y'] + s*q['w'],
                'z': c*q['z'] - s*q['x'], 'w': c*q['w'] - s*q['y']}})
            time.sleep(.4)
            moved = call(f'{label}-moved', 'ecs query', {'entityIndex': state_id})
            call(f'{label}-release', 'xr set-select-value', {'device': device, 'value': 0})
            time.sleep(.4)
            final = call(f'{label}-final', 'ecs query', {'entityIndex': state_id})
            yaw = key(final, 'yawDegrees')
            assert abs(yaw - yaw_before - delta) < 2, f'{mode} yaw failed to track the actual input heading'
            assert abs(yaw - key(moved, 'yawDegrees')) < 1, 'Released correction did not hold'
            assert key(final, 'isDragging') is False, 'Native grab did not release'
            assert abs(key(final, 'previewYawDegrees') - yaw) < .2, 'Video preview did not use the edited yaw'
            if mode == 'hand':
                assert key(final, 'inputKind') == 'hand-pinch', 'Hand source was not observed'
            interactions.append({'input': mode, 'selected_cut': key(final, 'selectedCut'),
                                 'initial_yaw': yaw_before, 'final_yaw': yaw,
                                 'held': True, 'released': True, 'preview_yaw': key(final, 'previewYawDegrees')})
            return final

        rotate('controller', 'controller-right', -25)
        call('hand-mode', 'xr set-input-mode', {'mode': 'hand'})
        time.sleep(.4)
        final = rotate('hand', 'hand-right', -30)
        assert key(final, 'aligned') is True, 'The two input rotations did not align the beacon'
        aligned_yaw = key(final, 'yawDegrees')
        hierarchy = call('runtime-hierarchy', 'scene runtime-hierarchy', {'maxDepth': 8})
        def named_uuid(data, name):
            if isinstance(data, dict):
                if data.get('name') == name: return data['uuid']
                for value in data.values():
                    found = named_uuid(value, name)
                    if found: return found
            elif isinstance(data, list):
                for value in data:
                    found = named_uuid(value, name)
                    if found: return found
        def click(name):
            global hierarchy
            uuid = named_uuid(hierarchy, name)
            if not uuid:
                hierarchy = call(f'{name}-hierarchy', 'scene runtime-hierarchy', {'maxDepth': 8})
                uuid = named_uuid(hierarchy, name)
            assert uuid, f'Runtime control {name} missing'
            transform = call(f'{name}-transform', 'scene transform', {'uuid': uuid})
            target = key(transform, 'positionRelativeToXROrigin')
            assert target, 'XR-relative control position missing'
            if isinstance(target, list): target = dict(zip(('x','y','z'), target))
            call(f'{name}-aim', 'xr look-at', {'device': 'hand-right', 'target': target})
            call(f'{name}-click', 'xr select', {'device': 'hand-right', 'duration': .2})

        def cut_state(label, selected, seconds, yaw, reference, total=2):
            # Native button clicks seek twice to refresh the reference image.
            deadline = time.monotonic() + 10
            while True:
                data = call(label, 'ecs query', {'entityIndex': state_id})
                if (key(data, 'selectedCut') == selected and key(data, 'totalCuts') == total
                        and abs(key(data, 'cutSeconds') - seconds) < .02
                        and abs(key(data, 'yawDegrees') - yaw) < 2
                        and abs(key(data, 'referenceYawDegrees') - reference) < 2):
                    return data
                if time.monotonic() >= deadline:
                    raise AssertionError(f'{label}: cut selection/time/yaw/reference did not settle')
                time.sleep(.2)

        click('cut-2')
        second_initial = cut_state('state-second-initial', 1, 8, 0, aligned_yaw)
        click('remove-cut')
        cut_state('state-second-removed', 0, 4, aligned_yaw, 0, total=1)
        click('add-cut')
        added = cut_state('state-second-added', 1, 8, aligned_yaw, aligned_yaw)
        click('earlier-frame')
        earlier = cut_state('state-second-earlier', 1, 7.9, aligned_yaw, aligned_yaw)
        click('later-frame')
        later = cut_state('state-second-later', 1, 8, aligned_yaw, aligned_yaw)
        second = rotate('second-hand', 'hand-right', 90)
        assert key(second, 'aligned') is True, 'Second cut did not align to the corrected previous shot'
        assert abs(key(second, 'yawDegrees') - 35) < 2
        assert abs(key(second, 'referenceYawDegrees') - aligned_yaw) < .2
        click('cut-1')
        first_retained = cut_state('state-first-retained', 0, 4, aligned_yaw, 0)
        click('cut-2')
        second_retained = cut_state('state-second-retained', 1, 8, 35, aligned_yaw)
        receipt['two_cut'] = {
            'initial_second_yaw': key(second_initial, 'yawDegrees'),
            'moved_seconds': [key(earlier, 'cutSeconds'), key(later, 'cutSeconds')],
            'recreated_inherited_yaw': key(added, 'yawDegrees'),
            'retained_yaws': [key(first_retained, 'yawDegrees'), key(second_retained, 'yawDegrees')],
            'second_reference_yaw': key(second_retained, 'referenceYawDegrees'),
            'native_add_remove': True, 'screenshot': 'xr-aligned.png',
        }
        call('ui-aligned', 'ui inspect', {'entityIndex': panel_id})
        call('runtime-image', 'browser screenshot', {}, extra=('--output-file', str(OUT / 'xr-aligned.png')))
        click('replay-cut')
        played = call('state-replayed', 'ecs query', {'entityIndex': state_id})
        assert key(played, 'cutCount') == 1, 'Real hand ray failed to replay the cut'

        click('review-panorama')
        reviewing = call('state-review-start', 'ecs query', {'entityIndex': state_id})
        assert key(reviewing, 'panoramaVisible') is True, 'Review button failed to open the panorama'
        assert key(reviewing, 'activeShot') == 'shot-1', 'Full-film review did not start at the first shot'
        deadline = time.monotonic() + 18
        while key(reviewing, 'activeShot') != 'shot-3' or abs(key(reviewing, 'reviewYawDegrees') - 35) >= 2:
            if time.monotonic() >= deadline:
                raise TimeoutError('Full-film review did not reach the corrected third shot')
            time.sleep(.5)
            reviewing = call('state-review-third-shot', 'ecs query', {'entityIndex': state_id})
        head_before = call('panorama-head-before', 'xr get-transform', {'device': 'headset'})
        click('review-original')
        original = call('state-review-original', 'ecs query', {'entityIndex': state_id})
        assert key(original, 'panoramaVisible') is True and key(original, 'correctedReview') is False
        assert abs(key(original, 'reviewYawDegrees')) < .1
        head_original = call('panorama-head-original', 'xr get-transform', {'device': 'headset'})
        click('review-corrected')
        corrected = call('state-review-corrected', 'ecs query', {'entityIndex': state_id})
        assert key(corrected, 'panoramaVisible') is True and key(corrected, 'correctedReview') is True
        assert abs(key(corrected, 'reviewYawDegrees') - 35) < 2
        head_corrected = call('panorama-head-corrected', 'xr get-transform', {'device': 'headset'})
        q_before = key(head_before, 'orientation')
        assert isinstance(q_before, dict), 'Measured headset orientation missing'
        for head in [head_original, head_corrected]:
            q = key(head, 'orientation')
            assert isinstance(q, dict), 'Measured headset orientation missing'
            dot = sum(q_before[axis] * q[axis] for axis in ('x', 'y', 'z', 'w'))
            assert abs(abs(dot) - 1) < 1e-5, 'A/B review moved the viewing direction'
            assert max(abs(a - b) for a, b in zip(position(head_before), position(head))) < 1e-5
        receipt['panorama'] = {
            'original_yaw': key(original, 'reviewYawDegrees'),
            'corrected_yaw': key(corrected, 'reviewYawDegrees'),
            'same_viewpoint': True,
            'headset_position': position(head_before),
            'headset_orientations': [key(head, 'orientation') for head in [head_before, head_original, head_corrected]],
            'screenshot': 'xr-panorama.png',
        }
        call('runtime-panorama', 'browser screenshot', {}, extra=('--output-file', str(OUT / 'xr-panorama.png')))
        click('review-export')
        deadline = time.monotonic() + 30
        while True:
            exported_ui = call('ui-exported', 'ui inspect', {'entityIndex': panel_id, 'selector': '#hint'})
            export_text = key(exported_ui, 'text') or ''
            if 'MP4 ready' in export_text: break
            if time.monotonic() > deadline: raise TimeoutError(f'XR export did not finish: {export_text}')
            time.sleep(2)
        click('review-panorama')
        cut_state('state-back-to-edit', 1, 8, 35, aligned_yaw)
        click('reset-yaw')
        reset = cut_state('state-reset', 1, 8, 0, aligned_yaw)
        assert abs(key(reset, 'yawDegrees')) < .1, 'Reset failed to clear the correction'
        assert key(reset, 'isDragging') is False
        assert key(reset, 'panoramaVisible') is False
        click('cut-1')
        retained_after_reset = cut_state('state-first-after-reset', 0, 4, aligned_yaw, 0)
        receipt['two_cut'].update(reset_selected_yaw=key(reset, 'yawDegrees'),
                                  retained_first_after_reset=key(retained_after_reset, 'yawDegrees'))
        receipt['panorama']['export_status'] = export_text
        assert key(call('xr-final', 'xr status', {}), 'sessionActive') is True
        console = call('console-final', 'browser logs', {'count': 40})
        assert 'GL_INVALID_VALUE' not in json.dumps(console), 'GPU texture dimensions failed during media upload'
        receipt.update(runtime_gate_passed=True, media_ready=True, state_entity=state_id,
                       interactions=interactions, aligned_yaw=aligned_yaw, aligned=True,
                       replay_count=key(played, 'cutCount'), export_status=export_text, reset_yaw=key(reset, 'yawDegrees'),
                       scope='Emulated hand/controller input and live XR export; no physical Quest performance claim')
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
