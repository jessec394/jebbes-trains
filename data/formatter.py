"""Rewrite data/map_data.py in its canonical layout (sorted, one entry per line). Run: python data/formatter.py"""
import os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, ROOT)

from core import paths
from core.datafile import load_namespace, format_map_data
from core.fileio import atomic_write

if __name__ == '__main__': atomic_write(paths.SIMPLE_FILE, format_map_data(load_namespace(paths.SIMPLE_FILE)))