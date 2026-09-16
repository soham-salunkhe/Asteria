# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['C:/Users/chowmeow/Desktop/Asteria/ai-service/fsoc_main.py'],
    pathex=['C:/Users/chowmeow/Desktop/Asteria/ai-service'],
    binaries=[],
    datas=[],
    hiddenimports=['uvicorn.logging', 'uvicorn.loops', 'uvicorn.loops.auto', 'uvicorn.loops.asyncio', 'uvicorn.protocols', 'uvicorn.protocols.http', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.http.h11_impl', 'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto', 'uvicorn.protocols.websockets.websockets_impl', 'uvicorn.lifespan', 'uvicorn.lifespan.on', 'fastapi', 'starlette', 'pydantic', 'pydantic_core', 'cv2', 'scipy', 'scipy.spatial.transform', 'reportlab', 'reportlab.pdfgen.canvas', 'reportlab.platypus', 'websockets', 'simulation.engine', 'simulation.camera', 'vision.video_processor', 'vision.detector', 'prediction.kalman', 'control.pid', 'analytics.metrics', 'database.models', 'reports.csv_report', 'reports.json_report', 'reports.pdf_report'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='tracking-engine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='tracking-engine',
)
