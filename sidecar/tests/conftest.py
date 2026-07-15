import sys
from pathlib import Path

# Make sidecar modules importable exactly as the sidecar itself imports them
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
