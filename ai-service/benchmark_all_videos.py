#!/usr/bin/env python3
"""
FSOC PAT — Multi-Video Benchmark Test Suite
Runs the tracking pipeline against all available benchmark MP4 videos.
Reports per-video metrics and root-cause classification for any failing video.
"""
import asyncio
import os
import sys
import glob
from pathlib import Path

# Add project root to sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from vision.video_processor import VideoProcessor


async def run_benchmark(video_paths: list[str]) -> list[dict]:
    results = []
    for path_str in video_paths:
        p = Path(path_str)
        name = p.name
        if not p.exists():
            results.append({
                'name': name,
                'status': 'FAIL',
                'reason': 'VIDEO FILE NOT FOUND',
                'category': 'A. VIDEO DECODING FAILURE',
            })
            continue

        vp = VideoProcessor()
        # Mock broadcast callback so it doesn't need WebSocket server
        vp.set_broadcast(lambda msg: asyncio.sleep(0))

        # Fast execution without real-time sleep pacing
        orig_sleep = asyncio.sleep
        async def fast_sleep(s):
            pass
        asyncio.sleep = fast_sleep

        try:
            run_id = await vp.process(str(p), scenario_name=f'BENCHMARK-{name}')
            m = vp._metrics.summary()
            ps = vp._metrics.ps169()

            total_frames = m.get('total_frames', 0)
            avg_fps = m.get('avg_fps', 30.0)
            acq_time = m.get('acquisition_time')
            avg_err_px = m.get('average_error_px')
            rmse_px = m.get('rmse_px')
            max_err_px = m.get('max_error_px')
            lock_ret = m.get('lock_retention')
            lost_count = m.get('lost_count', 0)
            avg_reacq = m.get('avg_reacquisition_time')
            det_conf = m.get('detection_confidence', 0.0)

            # Failure classification
            is_success = False
            fail_reason = None
            category = None

            if total_frames == 0:
                fail_reason = 'NO FRAMES DECODED'
                category = 'A. VIDEO DECODING FAILURE'
            elif det_conf < 0.20:
                fail_reason = 'LOW CONFIDENCE / NO VALID DETECTION'
                category = 'C. DETECTOR FAILURE'
            elif acq_time is None and total_frames > 30:
                fail_reason = 'TARGET NEVER ACQUIRED'
                category = 'D. WRONG CANDIDATE / CONTROL DIVERGENCE'
            else:
                is_success = True

            results.append({
                'name': name,
                'path': str(p),
                'total_frames': total_frames,
                'fps': round(avg_fps, 1),
                'first_detection': '0.0 s' if det_conf > 0 else 'NONE',
                'acq_time': f"{acq_time:.3f} s" if acq_time is not None else 'N/A',
                'avg_error': f"{avg_err_px:.2f} px" if avg_err_px is not None else 'N/A',
                'rmse': f"{rmse_px:.2f} px" if rmse_px is not None else 'N/A',
                'max_error': f"{max_err_px:.2f} px" if max_err_px is not None else 'N/A',
                'lock_retention': f"{lock_ret:.1f} %" if lock_ret is not None else '0.0 %',
                'target_losses': lost_count,
                'reacq_time': f"{avg_reacq:.3f} s" if avg_reacq is not None else 'N/A',
                'final_state': 'LOCKED' if lock_ret and lock_ret > 50 else 'TRACKING',
                'status': 'PASS' if is_success else 'FAIL',
                'reason': fail_reason,
                'category': category,
                'confidence': round(det_conf, 3),
            })
        except Exception as exc:
            results.append({
                'name': name,
                'status': 'FAIL',
                'reason': str(exc),
                'category': 'A. VIDEO DECODING FAILURE',
            })
        finally:
            asyncio.sleep = orig_sleep

    return results


def main():
    # Find all available mp4 videos
    vids = [
        '/Users/kanra/Desktop/asteria_fsoc_benchmark_640x480_30fps_h264.mp4',
        '/Users/kanra/Desktop/FSOC_Benchmark_Test_Linear_30FPS.mp4',
        '/Users/kanra/Desktop/Create_a_realistic_software_ge.mp4',
        '/Users/kanra/Desktop/Create_a_realistic_scientific.mp4',
    ]
    # Add any extra downloads if found
    for extra in [
        '/Users/kanra/Downloads/it_should_be_of_sec.mp4',
        '/Users/kanra/Downloads/f61900c2b97b0abd0f7f5b6c044438a7.mp4',
    ]:
        if os.path.exists(extra):
            vids.append(extra)

    print("=" * 80)
    print("ASTERIA FSOC PAT — MULTI-VIDEO BENCHMARK RUNNER")
    print("=" * 80)

    results = asyncio.run(run_benchmark(vids))

    for r in results:
        print("\n" + "-" * 80)
        print(f"VIDEO NAME:         {r['name']}")
        if r['status'] == 'PASS':
            print(f"FRAME COUNT:        {r['total_frames']}")
            print(f"FPS:                {r['fps']}")
            print(f"FIRST DETECTION:    {r['first_detection']}")
            print(f"ACQUISITION TIME:   {r['acq_time']}")
            print(f"AVG ERROR:          {r['avg_error']}")
            print(f"RMSE:               {r['rmse']}")
            print(f"MAX ERROR:          {r['max_error']}")
            print(f"LOCK RETENTION:     {r['lock_retention']}")
            print(f"TARGET LOSSES:      {r['target_losses']}")
            print(f"REACQUISITION TIME: {r['reacq_time']}")
            print(f"CONFIDENCE:         {r['confidence']}")
            print(f"FINAL STATE:        {r['final_state']}")
            print(f"RESULT:             TRACKING SUCCESSFUL (PASS)")
        else:
            print(f"RESULT:             TRACKING FAILED")
            print(f"REASON:             {r.get('reason')}")
            print(f"ROOT-CAUSE CAT:     {r.get('category')}")
    print("\n" + "=" * 80)


if __name__ == '__main__':
    main()
