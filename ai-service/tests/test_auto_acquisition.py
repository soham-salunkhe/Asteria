"""
Tests for Automatic Target Acquisition and Target Movement Tracking State Machine.
Validates:
1. SEARCHING -> ACQUIRING -> TRACKING -> LOCKED on detection
2. SEARCHING timeout -> REACQUIRING -> Automatic Search Again -> SEARCHING -> ACQUIRING -> LOCKED
3. Target movement while locked: continues tracking immediately without restarting initial acquisition
4. Target lost while locked: enters REACQUIRING and automatically searches again
"""
import sys
import os
import pytest

_HERE = os.path.dirname(__file__)
_ROOT = os.path.abspath(os.path.join(_HERE, '..'))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from simulation.engine import SimulationEngine


def test_state_machine_detected_flow():
    """Verify SEARCHING -> ACQUIRING -> TRACKING -> LOCKED sequence upon detection."""
    eng = SimulationEngine()
    eng._target_state = 'SEARCHING'
    
    # 1. Target detected -> enters ACQUIRING
    eng._update_target_state(detected=True, pix_total=8.0, dt=0.033)
    assert eng._target_state == 'ACQUIRING'
    
    # Stays in ACQUIRING for min_acquiring_frames - 1 frames
    for _ in range(eng._min_acquiring_frames - 1):
        eng._update_target_state(detected=True, pix_total=8.0, dt=0.033)
        assert eng._target_state == 'ACQUIRING'
        
    # Completes ACQUIRING -> transitions to TRACKING
    eng._update_target_state(detected=True, pix_total=8.0, dt=0.033)
    assert eng._target_state == 'TRACKING'
    
    # Error <= 10px for LOCK_FRAMES_REQUIRED frames -> transitions to LOCKED
    for _ in range(eng.LOCK_FRAMES_REQUIRED):
        eng._update_target_state(detected=True, pix_total=8.0, dt=0.033)
        
    assert eng._target_state == 'LOCKED'


def test_state_machine_search_timeout_retry():
    """Verify SEARCHING timeout -> REACQUIRING -> automatic search again."""
    eng = SimulationEngine()
    eng._target_state = 'SEARCHING'
    eng._search_timeout_s = 1.0  # 1 second timeout for test
    eng._reacquire_wait_time = 0.2
    
    # Not detected for 1.1 seconds:
    for _ in range(35): # 35 * 0.033 = 1.155s
        eng._update_target_state(detected=False, pix_total=None, dt=0.033)
        
    # Must have timed out to REACQUIRING
    assert eng._target_state == 'REACQUIRING'
    
    # Advance elapsed time beyond reacquire wait time:
    eng._elapsed += 0.3
    eng._update_target_state(detected=False, pix_total=None, dt=0.033)
    
    # Must have automatically restarted search
    assert eng._target_state == 'SEARCHING'


def test_state_machine_target_movement_while_locked():
    """Verify target movement while locked continues tracking immediately without restarting acquisition."""
    eng = SimulationEngine()
    eng._target_state = 'LOCKED'
    
    # Target moves (pixel error increases to 18px > 10px, but still in FOV)
    eng._update_target_state(detected=True, pix_total=18.0, dt=0.033)
    
    # Immediately continues tracking
    assert eng._target_state == 'TRACKING'
    
    # When PID pulls error back <= 10px
    for _ in range(eng.LOCK_FRAMES_REQUIRED):
        eng._update_target_state(detected=True, pix_total=5.0, dt=0.033)
        
    assert eng._target_state == 'LOCKED'


def test_state_machine_target_lost_and_reacquired():
    """Verify target lost enters REACQUIRING and automatically searches again."""
    eng = SimulationEngine()
    eng._target_state = 'LOCKED'
    eng._reacquire_wait_time = 0.2
    
    # Target moves far away (outside FOV -> detected=False)
    eng._update_target_state(detected=False, pix_total=None, dt=0.033)
    
    assert eng._target_state == 'REACQUIRING'
    
    # Wait time elapses
    eng._elapsed += 0.3
    eng._update_target_state(detected=False, pix_total=None, dt=0.033)
    
    assert eng._target_state == 'SEARCHING'
