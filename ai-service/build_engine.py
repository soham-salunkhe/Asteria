"""
Build script to compile ASTERIA Python Engine into standalone tracking-engine.exe
using PyInstaller.
"""
import sys
import subprocess
from pathlib import Path

def main():
    root = Path(__file__).resolve().parent
    dist_dir = root / 'dist'
    build_dir = root / 'build'

    cmd = [
        sys.executable, '-m', 'PyInstaller',
        '--noconfirm',
        '--onedir',
        '--name', 'tracking-engine',
        '--paths', str(root),
        '--hidden-import', 'uvicorn.logging',
        '--hidden-import', 'uvicorn.loops',
        '--hidden-import', 'uvicorn.loops.auto',
        '--hidden-import', 'uvicorn.loops.asyncio',
        '--hidden-import', 'uvicorn.protocols',
        '--hidden-import', 'uvicorn.protocols.http',
        '--hidden-import', 'uvicorn.protocols.http.auto',
        '--hidden-import', 'uvicorn.protocols.http.h11_impl',
        '--hidden-import', 'uvicorn.protocols.websockets',
        '--hidden-import', 'uvicorn.protocols.websockets.auto',
        '--hidden-import', 'uvicorn.protocols.websockets.websockets_impl',
        '--hidden-import', 'uvicorn.lifespan',
        '--hidden-import', 'uvicorn.lifespan.on',
        '--hidden-import', 'fastapi',
        '--hidden-import', 'starlette',
        '--hidden-import', 'pydantic',
        '--hidden-import', 'pydantic_core',
        '--hidden-import', 'cv2',
        '--hidden-import', 'scipy',
        '--hidden-import', 'scipy.spatial.transform',
        '--hidden-import', 'reportlab',
        '--hidden-import', 'reportlab.pdfgen.canvas',
        '--hidden-import', 'reportlab.platypus',
        '--hidden-import', 'websockets',
        '--hidden-import', 'simulation.engine',
        '--hidden-import', 'simulation.camera',
        '--hidden-import', 'vision.video_processor',
        '--hidden-import', 'vision.detector',
        '--hidden-import', 'prediction.kalman',
        '--hidden-import', 'control.pid',
        '--hidden-import', 'analytics.metrics',
        '--hidden-import', 'database.models',
        '--hidden-import', 'reports.csv_report',
        '--hidden-import', 'reports.json_report',
        '--hidden-import', 'reports.pdf_report',
        str(root / 'fsoc_main.py')
    ]

    print("Running PyInstaller...")
    print(" ".join(cmd))
    res = subprocess.run(cmd, cwd=str(root))
    if res.returncode != 0:
        print("Build failed with code", res.returncode)
        sys.exit(res.returncode)
    print("Successfully built tracking-engine in", dist_dir / 'tracking-engine')

if __name__ == '__main__':
    main()
