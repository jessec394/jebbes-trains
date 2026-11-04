import os, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
sys.path.insert(0, ROOT)

def ensure_packages():
    need = []
    for mod, pkg in (('osmium', 'osmium'), ('flask', 'flask')):
        try:
            __import__(mod)
        except ImportError:
            need.append(pkg)
    if need:
        print(f"Installing {', '.join(need)} ...")
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', *need])

def ensure_graph():
    from devtools import config
    if os.path.exists(config.GRAPH_DB): return
    from devtools.fetch import download
    from devtools.ingest import ingest
    ingest(download('north-america'))

def main():
    ensure_packages()
    ensure_graph()
    from devtools.__main__ import main as cli
    cli(['serve', '--open'])

if __name__ == '__main__':
    main()